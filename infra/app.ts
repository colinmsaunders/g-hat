import { App } from "aws-cdk-lib";
import { ChatStack } from "./stack";
const app = new App();
new ChatStack(app, "GeohashChat", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
