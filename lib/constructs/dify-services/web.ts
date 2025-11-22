import { CpuArchitecture, FargateTaskDefinition, ICluster } from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';
import { Duration, aws_ecs as ecs } from 'aws-cdk-lib';
import { IAlb } from '../alb';
import { IRepository } from 'aws-cdk-lib/aws-ecr';
import { EnvironmentProps } from '../../environment-props';
import { getAdditionalEnvironmentVariables, getAdditionalSecretVariables } from './environment-variables';
import * as iam from 'aws-cdk-lib/aws-iam';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';

export interface WebServiceProps {
  cluster: ICluster;
  alb: IAlb;

  imageTag: string;

  /**
   * If true, enable debug outputs
   * @default false
   */
  debug?: boolean;
  customRepository?: IRepository;

  additionalEnvironmentVariables: EnvironmentProps['additionalEnvironmentVariables'];
  useFargateSpot: boolean;
}

export class WebService extends Construct {
  constructor(scope: Construct, id: string, props: WebServiceProps) {
    super(scope, id);

    const { cluster, alb, debug = false, customRepository } = props;
    const port = 3000;

// 先创建 Execution Role
const executionRole = new iam.Role(this, 'TaskExecutionRole', {
  assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
  ],
});

// 添加 ECR 权限
executionRole.addToPolicy(new PolicyStatement({
  actions: [
    'ecr:GetAuthorizationToken',
    'ecr:BatchCheckLayerAvailability',
    'ecr:GetDownloadUrlForLayer',
    'ecr:BatchGetImage',
  ],
  resources: ['*'],
}));

const taskDefinition = new FargateTaskDefinition(this, 'Task', {
  cpu: 256,
  memoryLimitMiB: 512,
  runtimePlatform: { cpuArchitecture: CpuArchitecture.X86_64 },
  executionRole: executionRole,  // 使用我们创建的角色
});



    taskDefinition.addContainer('Main', {
      image: customRepository
        ? ecs.ContainerImage.fromEcrRepository(customRepository, `dify-web_${props.imageTag}`)
        : ecs.ContainerImage.fromRegistry(`123456789000.dkr.ecr.cn-north-1.amazonaws.com.cn/dify-web:${props.imageTag}`),
      environment: {
        // The log level for the application. Supported values are `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`
        LOG_LEVEL: debug ? 'DEBUG' : 'ERROR',
        // enable DEBUG mode to output more logs
        DEBUG: debug ? 'true' : 'false',

        // The base URL of console application api server, refers to the Console base URL of WEB service if console domain is different from api or web app domain.
        // example: http://cloud.dify.ai
        CONSOLE_API_URL: alb.url,
        // The URL prefix for Web APP frontend, refers to the Web App base URL of WEB service if web app domain is different from console or api domain.
        // example: http://udify.app
        APP_API_URL: alb.url,

        // Setting host to 0.0.0.0 seems necessary for health check to pass.
        // https://nextjs.org/docs/pages/api-reference/next-config-js/output
        HOSTNAME: '0.0.0.0',
        PORT: port.toString(),

        MARKETPLACE_API_URL: 'https://marketplace.dify.ai',
        MARKETPLACE_URL: 'https://marketplace.dify.ai',

        ...getAdditionalEnvironmentVariables(this, 'web', props.additionalEnvironmentVariables),
      },
      secrets: {
        ...getAdditionalSecretVariables(this, 'web', props.additionalEnvironmentVariables),
      },
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'log',
      }),
      portMappings: [{ containerPort: port }],
      healthCheck: {
        // use wget instead of curl due to alpine: https://stackoverflow.com/a/47722899/18550269
        command: ['CMD-SHELL', `wget --no-verbose --tries=1 --spider http://localhost:${port}/ || exit 1`],
        interval: Duration.seconds(15),
        startPeriod: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
      },
    });

    const service = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition,
      capacityProviderStrategies: [
        {
          capacityProvider: 'FARGATE',
          weight: props.useFargateSpot ? 0 : 1,
        },
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: props.useFargateSpot ? 1 : 0,
        },
      ],
      enableExecuteCommand: true,
      minHealthyPercent: 100,
    });

    alb.addEcsService('Web', service, port, '/', ['/*']);
  }
}
