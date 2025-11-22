# Dify 中国区部署方案

本项目是 github.com/langgenius/dify Note: Please be mindful when interacting with displayed links. 在 AWS 中国区(北京/宁夏)的完整部署方案。

## ⚠️ 重要说明

代码中的 ECR 镜像地址包含示例账号 ID (`123456789000`)。
**在实际部署时,请替换为你自己的 AWS 账号 ID。**

## 主要修改

1. **禁用 CloudFront** - 中国区 VpcOrigin 不支持
2. **注释 RDS Data API** - 中国区不可用
3. **配置 ECR 镜像** - 使用中国区 ECR 存储镜像
4. **添加 ECR 权限** - Task Execution Role 权限配置
5. **修复 S3 端点** - 使用中国区 S3 端点(`s3.cn-north-1.amazonaws.com.cn`)

## 部署前准备

### 1. 替换账号 ID

在以下文件中,将 `123456789000` 替换为你的 AWS 账号 ID:
- `lib/constructs/dify-services/api.ts`
- `lib/constructs/dify-services/web.ts`

### 2. 上传镜像到 ECR

详见原始 README.md 的镜像准备部分。

## 部署步骤

详见原始 README.md

## 注意事项

- 需要先在 ECR 中创建仓库并上传镜像
- 部署后需要在 ALB 监听器中配置默认规则
- S3 端点已配置为中国区端点

## 许可证

MIT-0

