import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as deployment from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { existsSync } from "node:fs";
export interface BackendTarget {
  region: string;
  apiId: string;
  bucketName: string;
  userPoolId: string;
  userPoolClientId: string;
  tableName: string;
}
export interface ChatStackProps extends cdk.StackProps {
  regionalOnly?: boolean;
  readOnly?: boolean;
  edgeDistributionId?: string;
  backendTarget?: BackendTarget;
}
export class ChatStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: ChatStackProps) {
    super(scope, id, props);
    const table = new dynamodb.Table(this, "PostsV3", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });
    const controls = new dynamodb.Table(this, "ControlV3", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });
    new cdk.CfnOutput(this, "ControlTableName", { value: controls.tableName });
    new cloudwatch.Dashboard(this, "StorageDashboard", {
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: "Slot storage capacity and throttling",
            left: [
              table.metricConsumedReadCapacityUnits(),
              table.metricConsumedWriteCapacityUnits(),
            ],
            right: [
              table.metricThrottledRequestsForOperations({
                operations: [
                  dynamodb.Operation.QUERY,
                  dynamodb.Operation.BATCH_WRITE_ITEM,
                ],
              }),
            ],
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: "Slot storage latency",
            left: [
              table.metricSuccessfulRequestLatency({
                dimensionsMap: {
                  TableName: table.tableName,
                  Operation: "Query",
                },
              }),
              table.metricSuccessfulRequestLatency({
                dimensionsMap: {
                  TableName: table.tableName,
                  Operation: "BatchWriteItem",
                },
              }),
            ],
          }),
        ],
      ],
    });
    const pool = new cognito.UserPool(this, "Users", {
      selfSignUpEnabled: !props?.readOnly,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        nickname: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const poolClient = pool.addClient("Web", {
      authFlows: { userPassword: true },
      preventUserExistenceErrors: true,
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
    });
    new cognito.CfnUserPoolGroup(this, "Moderators", {
      userPoolId: pool.userPoolId,
      groupName: "moderators",
      description: "May review reports, remove messages, and ban identities.",
    });
    const fn = new NodejsFunction(this, "ApiHandler", {
      entry: "apps/api/src/handler.ts",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler",
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      reservedConcurrentExecutions: 50,
      bundling: { minify: true, sourceMap: true, externalModules: [] },
      environment: {
        READ_ONLY: props?.readOnly ? "true" : "false",
        POSTS_TABLE_NAME: table.tableName,
        CONTROL_TABLE_NAME: controls.tableName,
        USER_POOL_ID: pool.userPoolId,
        USER_POOL_CLIENT_ID: poolClient.userPoolClientId,
      },
      logGroup: new logs.LogGroup(this, "ApiLogs", {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    table.grantReadWriteData(fn);
    controls.grantReadWriteData(fn);
    const api = new apigw.HttpApi(this, "HttpApi", {
      createDefaultStage: false,
    });
    api.addRoutes({
      path: "/api/{proxy+}",
      methods: [apigw.HttpMethod.ANY],
      integration: new HttpLambdaIntegration("Handler", fn),
    });
    new apigw.HttpStage(this, "DefaultStage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 100, burstLimit: 200 },
    });
    const bucket = new s3.Bucket(this, "WebAssets", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const webPath = "apps/web/dist";
    if (!existsSync(`${webPath}/index.html`))
      throw new Error("Build the frontend first: npm run build");
    const target = props?.backendTarget;
    const config = {
      apiUrl: "/api",
      region: target?.region ?? this.region,
      userPoolId: target?.userPoolId ?? pool.userPoolId,
      userPoolClientId: target?.userPoolClientId ?? poolClient.userPoolClientId,
      local: false,
    };
    if (props?.regionalOnly) {
      if (!props.edgeDistributionId)
        throw new Error(
          "Regional assets require the existing edge distribution ID.",
        );
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
          actions: ["s3:GetObject"],
          resources: [bucket.arnForObjects("*")],
          conditions: {
            StringEquals: {
              "AWS:SourceArn": `arn:${this.partition}:cloudfront::${this.account}:distribution/${props.edgeDistributionId}`,
            },
          },
        }),
      );
      new deployment.BucketDeployment(this, "PublishWeb", {
        destinationBucket: bucket,
        sources: [
          deployment.Source.asset(webPath),
          deployment.Source.jsonData("config.json", config),
        ],
        cacheControl: [deployment.CacheControl.noCache()],
      });
      new cloudwatch.Alarm(this, "ApiErrors", {
        metric: fn.metricErrors(),
        threshold: 5,
        evaluationPeriods: 1,
      });
      new cdk.CfnOutput(this, "ApiId", { value: api.apiId });
      new cdk.CfnOutput(this, "ApiEndpoint", { value: api.apiEndpoint });
      new cdk.CfnOutput(this, "BucketName", { value: bucket.bucketName });
      new cdk.CfnOutput(this, "TableName", { value: table.tableName });
      new cdk.CfnOutput(this, "UserPoolId", { value: pool.userPoolId });
      new cdk.CfnOutput(this, "UserPoolClientId", {
        value: poolClient.userPoolClientId,
      });
      new cdk.CfnOutput(this, "ApiFunctionName", { value: fn.functionName });
      return;
    }
    const assetOrigin = target
      ? s3.Bucket.fromBucketAttributes(this, "WesternAssets", {
          bucketName: target.bucketName,
          region: target.region,
        })
      : bucket;
    const domain = this.node.tryGetContext("domain") as string | undefined;
    let zone: route53.IHostedZone | undefined;
    let certificate: acm.ICertificate | undefined;
    if (domain) {
      if (this.region !== "us-east-1")
        throw new Error(
          "Deploy in us-east-1 when using a custom domain (CloudFront certificate requirement).",
        );
      const hostedZoneId = this.node.tryGetContext("hostedZoneId") as
        string | undefined;
      zone = hostedZoneId
        ? route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
            hostedZoneId,
            zoneName: domain,
          })
        : route53.HostedZone.fromLookup(this, "Zone", { domainName: domain });
      certificate = new acm.Certificate(this, "Certificate", {
        domainName: domain,
        validation: acm.CertificateValidation.fromDns(zone),
      });
    }
    // Rewrite only navigation paths. API errors and missing assets keep their real status.
    const rewrite = new cloudfront.Function(this, "SpaRoutes", {
      code: cloudfront.FunctionCode.fromInline(
        String.raw`function handler(event) { var r=event.request; if (r.uri === '/' || /^\/[0-9bcdefghjkmnpqrstuvwxyz]{1,8}\/?$/.test(r.uri)) r.uri='/index.html'; return r; }`,
      ),
    });
    const distribution = new cloudfront.Distribution(this, "Web", {
      defaultRootObject: "index.html",
      domainNames: domain ? [domain] : undefined,
      certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(assetOrigin),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [
          {
            function: rewrite,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.HttpOrigin(
            `${target?.apiId ?? api.apiId}.execute-api.${target?.region ?? this.region}.${this.urlSuffix}`,
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });
    if (zone && domain) {
      new route53.ARecord(this, "Alias", {
        zone,
        recordName: domain,
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(distribution),
        ),
      });
      new route53.AaaaRecord(this, "AliasV6", {
        zone,
        recordName: domain,
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(distribution),
        ),
      });
    }
    new deployment.BucketDeployment(this, "PublishWeb", {
      destinationBucket: bucket,
      sources: [
        deployment.Source.asset(webPath),
        deployment.Source.jsonData("config.json", config),
      ],
      distribution,
      distributionPaths: ["/*"],
      cacheControl: [deployment.CacheControl.noCache()],
    });
    new cloudwatch.Alarm(this, "ApiErrors", {
      metric: fn.metricErrors(),
      threshold: 5,
      evaluationPeriods: 1,
      alarmDescription:
        "Inspect API logs; add an SNS alarm action before public launch.",
    });
    new cdk.CfnOutput(this, "SiteUrl", {
      value: `https://${domain ?? distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "UserPoolId", {
      value: target?.userPoolId ?? pool.userPoolId,
    });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: target?.userPoolClientId ?? poolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "TableName", {
      value: target?.tableName ?? table.tableName,
    });
  }
}
