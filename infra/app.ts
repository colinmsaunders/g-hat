import { App } from "aws-cdk-lib";
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
function flag(name: string, fallback = false): boolean {
  const value = app.node.tryGetContext(name);
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`Invalid boolean context: ${name}`);
}
// Keep the existing edge stack in us-east-1 to preserve its distribution and ACM certificate.
new ChatStack(app, "GeohashChat", {
  env: { account: targetAccount, region: "us-east-1" },
  readOnly: flag("eastReadOnly"),
  backendTarget: app.node.tryGetContext("backendTarget") as
    BackendTarget | undefined,
});
if (flag("enableWest")) {
  new ChatStack(app, "GeohashChatWest", {
    env: { account: targetAccount, region: "us-west-2" },
    regionalOnly: true,
    readOnly: flag("westReadOnly", true),
    edgeDistributionId: "E17G6J5BI86OTG",
  });
}
