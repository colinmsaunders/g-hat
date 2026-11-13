import { App, Tags } from "aws-cdk-lib";
import { ChatStack, type BackendTarget } from "./stack";
const targetAccount = "451261323611";
if (
  process.env.CDK_DEFAULT_ACCOUNT &&
  process.env.CDK_DEFAULT_ACCOUNT !== targetAccount
) {
  throw new Error(
    `Refusing deployment: expected AWS account ${targetAccount}, received ${process.env.CDK_DEFAULT_ACCOUNT}.`,
  );
}
const app = new App();
Tags.of(app).add("Application", "geochalk");
Tags.of(app).add("ArchitectureVersion", "v1");
function flag(name: string, fallback = false): boolean {
  const value = app.node.tryGetContext(name);
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`Invalid boolean context: ${name}`);
}
// CloudFront certificates must be in us-east-1. The backend lives in us-west-2.
new ChatStack(app, "Geochalk", {
  env: { account: targetAccount, region: "us-east-1" },
  readOnly: flag("eastReadOnly"),
  backendTarget: app.node.tryGetContext("backendTarget") as
    BackendTarget | undefined,
});
if (flag("enableWest")) {
  new ChatStack(app, "GeochalkWest", {
    env: { account: targetAccount, region: "us-west-2" },
    regionalOnly: true,
    readOnly: flag("westReadOnly", true),
    edgeDistributionId: app.node.tryGetContext("edgeDistributionId"),
  });
}
