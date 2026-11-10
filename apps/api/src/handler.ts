import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { createApp } from "./app";
import { DynamoStore } from "./dynamo";
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: "id",
  clientId: process.env.USER_POOL_CLIENT_ID!,
});
const app = createApp(
  new DynamoStore(process.env.TABLE_NAME!),
  async (token) => {
    const claims = await verifier.verify(token);
    return {
      id: `user:${claims.sub}`,
      name: typeof claims.nickname === "string" ? claims.nickname : "Member",
      moderator: (claims["cognito:groups"] ?? []).includes("moderators"),
    };
  },
);
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const result = await app({
    method: event.requestContext.http.method,
    path: event.rawPath,
    query: new URLSearchParams(event.rawQueryString),
    token: event.headers.authorization?.replace(/^Bearer /i, ""),
    body: event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString()
      : event.body,
    ip: event.requestContext.http.sourceIp,
  });
  return {
    statusCode: result.status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(result.body),
  };
};
