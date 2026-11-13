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
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      }),
    });
    const tables = template.findResources("AWS::DynamoDB::Table");
    const posts = Object.entries(tables).find(([id]) =>
      id.startsWith("PostsV1"),
    )![1];
    expect(posts.Properties).not.toHaveProperty("TimeToLiveSpecification");
    expect(posts.Properties).not.toHaveProperty("LocalSecondaryIndexes");
    expect(posts.Properties).not.toHaveProperty("GlobalSecondaryIndexes");
    expect(posts.Properties.KeySchema).toEqual([
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ]);
    const archive = Object.entries(tables).find(([id]) =>
      id.startsWith("PostArchiveV1"),
    )![1];
    expect(archive.DeletionPolicy).toBe("Retain");
    expect(archive.Properties).not.toHaveProperty("TimeToLiveSpecification");
    expect(archive.Properties.KeySchema).toEqual([
      { AttributeName: "postId", KeyType: "HASH" },
    ]);
    expect(
      archive.Properties.PointInTimeRecoverySpecification
        .PointInTimeRecoveryEnabled,
    ).toBe(true);
    const policy = Object.values(template.findResources("AWS::IAM::Policy"))
      .flatMap((r: any) => r.Properties.PolicyDocument.Statement)
      .find((s: any) => JSON.stringify(s.Resource).includes("PostArchiveV1"));
    expect(policy.Action).toEqual(["dynamodb:PutItem", "dynamodb:GetItem"]);
    template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
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
    const routing = Object.values(
      template.findResources("AWS::CloudFront::Function"),
    )[0].Properties.FunctionCode;
    const route = new Function(`${routing}; return handler;`)();
    for (const uri of ["/", "/_", "/_/", "/9q8yy", "/9q8yy/"])
      expect(route({ request: { uri } }).uri).toBe("/index.html");
    for (const uri of [
      "/api/health",
      "/assets/app.js",
      "/config.json",
      "/invalid",
    ])
      expect(route({ request: { uri } }).uri).toBe(uri);
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

describe("western region preparation", () => {
  it("creates a frozen regional backend without replacing the existing CDN or DNS", () => {
    const app = new App();
    const stack = new ChatStack(app, "TestWest", {
      env: { account: "451261323611", region: "us-west-2" },
      regionalOnly: true,
      readOnly: true,
      edgeDistributionId: "TEST_GEOCHALK_DISTRIBUTION",
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::CloudFront::Distribution", 0);
    template.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    template.resourceCountIs("AWS::Route53::RecordSet", 0);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ READ_ONLY: "true" }) },
    });
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "cloudfront.amazonaws.com" },
            Condition: {
              StringEquals: {
                "AWS:SourceArn": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:",
                      { Ref: "AWS::Partition" },
                      ":cloudfront::451261323611:distribution/TEST_GEOCHALK_DISTRIBUTION",
                    ],
                  ],
                },
              },
            },
          }),
        ]),
      },
    });
  }, 30000);
  it("switches origins without moving the certificate or dropping the legacy resources", () => {
    const app = new App({
      context: {
        domain: "geochalk.com",
        hostedZoneId: "Z03155483MXGI0J176IXN",
      },
    });
    const stack = new ChatStack(app, "TestEdge", {
      env: { account: "451261323611", region: "us-east-1" },
      readOnly: true,
      backendTarget: {
        region: "us-west-2",
        apiId: "westernapi",
        bucketName: "western-assets",
        userPoolId: "us-west-2_test",
        userPoolClientId: "client",
        tableName: "western-table",
      },
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    template.resourceCountIs("AWS::DynamoDB::Table", 3);
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    template.resourceCountIs("AWS::CertificateManager::Certificate", 1);
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "geochalk.com",
      DomainValidationOptions: [
        {
          DomainName: "geochalk.com",
          HostedZoneId: "Z03155483MXGI0J176IXN",
        },
      ],
    });
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "geochalk.com.",
      HostedZoneId: "Z03155483MXGI0J176IXN",
      Type: "A",
    });

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["geochalk.com"],
        Origins: Match.arrayWith([
          Match.objectLike({
            DomainName: {
              "Fn::Join": [
                "",
                [
                  "westernapi.execute-api.us-west-2.",
                  { Ref: "AWS::URLSuffix" },
                ],
              ],
            },
          }),
        ]),
      }),
    });
  }, 30000);
});
