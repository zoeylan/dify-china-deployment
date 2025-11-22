import { Construct } from 'constructs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Connections, IConnectable, IVpc } from 'aws-cdk-lib/aws-ec2';
import { CfnOutput, CfnResource, Duration, RemovalPolicy, Stack, CustomResource } from 'aws-cdk-lib';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { TimeSleep } from 'cdk-time-sleep';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';

export interface PostgresProps {
  vpc: IVpc;

  /**
   * If true, create an bastion instance.
   * @default false
   */
  createBastion?: boolean;

  /**
   * If true, the minimum ACU for the Aurora Cluster is set to zero.
   */
  scalesToZero: boolean;
}

export class Postgres extends Construct implements IConnectable {
  public readonly connections: Connections;
  public readonly cluster: rds.DatabaseCluster;
  public readonly secret: ISecret;
  public readonly databaseName = 'main';
  public readonly pgVectorDatabaseName = 'pgvector';

  private readonly queries: AwsCustomResource[] = [];
  private readonly writerId = 'Writer';
  private readonly props: PostgresProps;

  constructor(scope: Construct, id: string, props: PostgresProps) {
    super(scope, id);
    this.props = props;

    const { vpc } = props;
    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_15_7,
    });

    const cluster = new rds.DatabaseCluster(this, 'Cluster', {
      engine,
      vpc,
      serverlessV2MinCapacity: props.scalesToZero ? 0 : 0.5,
      serverlessV2MaxCapacity: 2.0,
      writer: rds.ClusterInstance.serverlessV2(this.writerId, {
        autoMinorVersionUpgrade: true,
        publiclyAccessible: false,
      }),
      defaultDatabaseName: this.databaseName,
      enableDataApi: true,
      storageEncrypted: true,
      removalPolicy: RemovalPolicy.DESTROY,
      parameterGroup: new rds.ParameterGroup(this, 'ParameterGroup', {
        engine,
        parameters: {
          // Terminate idle session for Aurora Serverless V2 auto-pause
          idle_session_timeout: '60000',
        },
      }),
      vpcSubnets: vpc.selectSubnets({ subnets: vpc.privateSubnets.concat(vpc.isolatedSubnets) }),
    });

    if (props.createBastion) {
      const host = new ec2.BastionHostLinux(this, 'BastionHost', {
        vpc,
        machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
        blockDevices: [
          {
            deviceName: '/dev/sdf',
            volume: ec2.BlockDeviceVolume.ebs(8, {
              encrypted: true,
            }),
          },
        ],
      });

      new CfnOutput(this, 'PortForwardCommand', {
        value: `aws ssm start-session --region ${Stack.of(this).region} --target ${
          host.instanceId
        } --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters '{"portNumber":["${
          cluster.clusterEndpoint.port
        }"], "localPortNumber":["${cluster.clusterEndpoint.port}"], "host": ["${cluster.clusterEndpoint.hostname}"]}'`,
      });
      new CfnOutput(this, 'DatabaseSecretsCommand', {
        value: `aws secretsmanager get-secret-value --secret-id ${cluster.secret!.secretName} --region ${
          Stack.of(this).region
        }`,
      });
    }

    this.connections = cluster.connections;
    this.cluster = cluster;
    this.secret = cluster.secret!;

   // this.runQuery(`CREATE DATABASE ${this.pgVectorDatabaseName};`, undefined);
   // this.runQuery('CREATE EXTENSION IF NOT EXISTS vector;', this.pgVectorDatabaseName);
   // 自动初始化数据库
    this.initializeDatabase();


  }



  private runQuery(sql: string, database: string | undefined) {
    const cluster = this.cluster;
    const query = new AwsCustomResource(this, `Query${this.queries.length}`, {
      onUpdate: {
        // will also be called for a CREATE event
        service: 'rds-data',
        action: 'ExecuteStatement',
        parameters: {
          resourceArn: cluster.clusterArn,
          secretArn: cluster.secret!.secretArn,
          database: database,
          sql: sql,
        },
        physicalResourceId: PhysicalResourceId.of(cluster.clusterArn),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [cluster.clusterArn] }),
    });
    cluster.secret!.grantRead(query);
    cluster.grantDataApiAccess(query);
    if (this.queries.length > 0) {
      // We assume each query must be called serially, not in parallel.
      query.node.defaultChild!.node.addDependency(this.queries.at(-1)!.node.defaultChild!);
    } else {
      // When the Data API is called immediately after the writer creation, we got the below error:
      // > Message returned: HttpEndpoint is not enabled for resource ...
      // So we wait a minute after the creation before the first Data API call.
      const sleep = new TimeSleep(this, 'WaitForHttpEndpointReady', {
        createDuration: Duration.seconds(60),
      });
      const dbInstance = this.cluster.node.findChild(this.writerId).node.defaultChild!;
      sleep.node.defaultChild!.node.addDependency(dbInstance);
      query.node.defaultChild!.node.addDependency(sleep);
    }
    this.queries.push(query);
    return query;
  }
private initializeDatabase() {
  // 创建 Lambda Layer
const psycopg2Layer = new lambda.LayerVersion(this, 'Psycopg2Layer', {
  code: lambda.Code.fromAsset('lambda-layers/psycopg2'),
  compatibleRuntimes: [lambda.Runtime.PYTHON_3_11],
  description: 'psycopg2 for database initialization',
});

  // 创建初始化 Lambda
  const initFunction = new lambda.Function(this, 'DbInitFunction', {
    runtime: lambda.Runtime.PYTHON_3_11,
    handler: 'index.handler',
    timeout: Duration.minutes(5),
    vpc: this.props.vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    layers: [psycopg2Layer],
    code: lambda.Code.fromInline(`
import json
import psycopg2
import os

def handler(event, context):
    request_type = event.get('RequestType', 'Create')

    if request_type == 'Delete':
        return {
            'PhysicalResourceId': 'db-init',
            'Data': {'Status': 'Deleted'}
        }

    try:
        # 连接到 postgres 数据库
        conn = psycopg2.connect(
            host=os.environ['DB_HOST'],
            port=int(os.environ['DB_PORT']),
            user=os.environ['DB_USER'],
            password=os.environ['DB_PASSWORD'],
            database='postgres',
            connect_timeout=10
        )
        conn.autocommit = True
        cursor = conn.cursor()

        # 检查并创建 pgvector 数据库
        cursor.execute("SELECT 1 FROM pg_database WHERE datname='pgvector'")
        if not cursor.fetchone():
            print("Creating pgvector database...")
            cursor.execute("CREATE DATABASE pgvector")
        else:
            print("pgvector database already exists")

        cursor.close()
        conn.close()

        # 连接到 pgvector 数据库安装扩展
        conn = psycopg2.connect(
            host=os.environ['DB_HOST'],
            port=int(os.environ['DB_PORT']),
            user=os.environ['DB_USER'],
            password=os.environ['DB_PASSWORD'],
            database='pgvector',
            connect_timeout=10
        )
        conn.autocommit = True
        cursor = conn.cursor()

        # 安装扩展
        print("Installing vector extension...")
        cursor.execute("CREATE EXTENSION IF NOT EXISTS vector")

        print("Installing uuid-ossp extension...")
        cursor.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')

        # 验证扩展
        cursor.execute("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'uuid-ossp')")
        extensions = cursor.fetchall()
        print(f"Installed extensions: {extensions}")

        cursor.close()
        conn.close()

        return {
            'PhysicalResourceId': 'db-init',
            'Data': {
                'Status': 'Success',
                'Extensions': str(extensions)
            }
        }

    except Exception as e:
        error_msg = f"Database initialization failed: {str(e)}"
        print(error_msg)
        raise Exception(error_msg)
    `),
    environment: {
      DB_HOST: this.cluster.clusterEndpoint.hostname,
      DB_PORT: this.cluster.clusterEndpoint.port.toString(),
    },
  });

  // 从 Secrets Manager 读取凭证
  this.secret.grantRead(initFunction);

  // 添加环境变量
  initFunction.addEnvironment(
    'DB_USER',
    this.secret.secretValueFromJson('username').unsafeUnwrap()
  );
  initFunction.addEnvironment(
    'DB_PASSWORD',
    this.secret.secretValueFromJson('password').unsafeUnwrap()
  );

  // 允许 Lambda 访问数据库
  this.cluster.connections.allowFrom(
    initFunction,
    ec2.Port.tcp(this.cluster.clusterEndpoint.port)
  );

  // 创建自定义资源
  const provider = new Provider(this, 'DbInitProvider', {
    onEventHandler: initFunction,
  });

  new CustomResource(this, 'DbInitResource', {
    serviceToken: provider.serviceToken,
  });
}


}
