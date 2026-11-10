import { describe, it, expect } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { ChatStack } from "../infra/stack";
describe("AWS deployment guardrails", () => {
  it("keeps durable data and buckets private and API responses uncached", () => {
    const app = new App();
    const stack = new ChatStack(app, "TestChat", {
      env: { account: "111111111111", region: "us-east-1" },
    });
    const template = Template.fromStack(stack);
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        BillingMode: "PAY_PER_REQUEST",
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      }),
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/api/*",
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
            AllowedMethods: [
              "GET",
              "HEAD",
              "OPTIONS",
              "PUT",
              "PATCH",
              "POST",
              "DELETE",
            ],
          }),
        ]),
      }),
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolGroup", {
      GroupName: "moderators",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      ReservedConcurrentExecutions: 50,
    });
    expect(
      Object.keys(template.findResources("AWS::Route53::RecordSet")),
    ).toHaveLength(0);
  }, 30000);
});
