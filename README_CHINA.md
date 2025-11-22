# Dify 中国区部署指南

这是一个完整的、可复用的 Dify 在 AWS 中国区(北京 cn-north-1)的部署方案。

## 🌟 特点

- ✅ 完全适配中国区
- ✅ 自动初始化数据库
- ✅ 解决所有中国区兼容性问题
- ✅ 一键部署

## 🔧 中国区适配修改

本项目针对中国区做了以下关键修改:

### 1. 禁用 CloudFront VpcOrigin
- **原因**: VpcOrigin 在中国区不支持
- **修改**: 在 `bin/cdk.ts` 中设置 `useCloudFront: false`

### 2. 使用 Lambda 自动初始化数据库
- **原因**: RDS Data API 在中国区不可用
- **修改**: 在 `lib/constructs/postgres.ts` 中添加 Lambda 函数
- **功能**: 自动创建 pgvector 数据库和必要的扩展

### 3. 配置 ECR 镜像
- **原因**: 从 Docker Hub 拉取镜像不稳定
- **修改**: 在 `lib/constructs/dify-services/` 中配置 ECR 镜像地址

### 4. 添加 Task Execution Role ECR 权限
- **原因**: ECS 需要权限从 ECR 拉取镜像
- **修改**: 在 `api.ts` 和 `web.ts` 中添加 IAM 权限

### 5. 修复 S3 端点
- **原因**: 中国区 S3 端点不同
- **修改**: 在 `api.ts` 中配置 `S3_ENDPOINT`

## 📋 部署前准备

### 1. 环境要求

- Node.js 18+
- AWS CLI 配置(中国区)
- AWS CDK
- Docker(用于构建镜像)

### 2. 替换账号 ID

**重要**: 将代码中的示例账号 ID `123456789000` 替换为你的实际 AWS 账号 ID:

\`\`\`bash
# 获取你的账号 ID
aws sts get-caller-identity --query Account --output text

# 批量替换(将 YOUR_ACCOUNT_ID 替换为上面获取的账号 ID)
find. -type f \\( -name "*.ts" -o -name "*.js" \\) \\
  -not -path "./node_modules/*" \\
  -not -path "./cdk.out/*" \\
  -exec sed -i 's/123456789000/YOUR_ACCOUNT_ID/g' {} +
\`\`\`

### 3. 准备 ECR 镜像

详细步骤请参考部署文档。

## 🚀 部署步骤

### 1. 克隆代码

\`\`\`bash
git clone github.com/zoeylan/dify-china-deployment.git Note: Please be mindful when interacting with displayed links.
cd dify-china-deployment
\`\`\`

### 2. 安装依赖

\`\`\`bash
npm install
\`\`\`

### 3. 配置 AWS CLI

\`\`\`bash
aws configure
# 输入: Access Key, Secret Key, 区域(cn-north-1)
\`\`\`

### 4. Bootstrap CDK

\`\`\`bash
cdk bootstrap aws://YOUR_ACCOUNT_ID/cn-north-1
\`\`\`

### 5. 部署

\`\`\`bash
npx cdk deploy --all
\`\`\`

部署大约需要 15-20 分钟。

## 📝 部署后配置

### 配置 ALB 默认规则

在 AWS 控制台:
1. 进入 EC2 → 负载均衡器
2. 选择 Dify 的 ALB
3. 点击 监听器 → HTTP:80
4. 编辑默认规则
5. 改为 "转发到" Web 目标组

### 访问 Dify

使用部署输出的 ALB DNS 地址访问 Dify。
