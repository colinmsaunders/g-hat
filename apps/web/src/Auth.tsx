import { useState } from "react";
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { config, saveToken } from "./api";
export function Auth({
  onDone,
  onClose,
}: {
  onDone: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"login" | "signup" | "confirm">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const client = new CognitoIdentityProviderClient({
        region: config.region,
      });
      const ClientId = config.userPoolClientId!;
      if (mode === "signup") {
        await client.send(
          new SignUpCommand({
            ClientId,
            Username: email,
            Password: password,
            UserAttributes: [
              { Name: "email", Value: email },
              { Name: "nickname", Value: name },
            ],
          }),
        );
        setMode("confirm");
      } else if (mode === "confirm") {
        await client.send(
          new ConfirmSignUpCommand({
            ClientId,
            Username: email,
            ConfirmationCode: code,
          }),
        );
        setMode("login");
        setError("Email confirmed. You can now sign in.");
      } else {
        const r = await client.send(
          new InitiateAuthCommand({
            ClientId,
            AuthFlow: "USER_PASSWORD_AUTH",
            AuthParameters: { USERNAME: email, PASSWORD: password },
          }),
        );
        if (!r.AuthenticationResult?.IdToken)
          throw Error("This account requires an additional sign-in challenge.");
        saveToken(r.AuthenticationResult.IdToken);
        onDone();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overlay">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
      >
        <button className="close" aria-label="Close sign in" onClick={onClose}>
          ×
        </button>
        <span className="eyebrow">A familiar face</span>
        <h2 id="auth-title">
          {mode === "login"
            ? "Welcome back."
            : mode === "signup"
              ? "Make yourself at home."
              : "Check your inbox."}
        </h2>
        {config.local ? (
          <p>
            Accounts are available after AWS deployment. You can explore and
            chat as a guest in local mode.
          </p>
        ) : (
          <form onSubmit={submit}>
            <label>
              Email
              <input
                autoFocus
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {mode === "signup" && (
              <label>
                Display name
                <input
                  required
                  minLength={2}
                  maxLength={24}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
            {mode === "confirm" ? (
              <label>
                Verification code
                <input
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
            ) : (
              <label>
                Password
                <input
                  type="password"
                  autoComplete={
                    mode === "signup" ? "new-password" : "current-password"
                  }
                  required
                  minLength={mode === "signup" ? 12 : 1}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            )}
            {mode === "signup" && (
              <small>
                12+ characters, with uppercase, lowercase, a number and a
                symbol.
              </small>
            )}
            <p role="status">{error}</p>
            <button className="primary" disabled={busy}>
              {busy
                ? "One moment…"
                : mode === "login"
                  ? "Sign in"
                  : mode === "signup"
                    ? "Create account"
                    : "Verify email"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setMode(mode === "login" ? "signup" : "login");
                setError("");
              }}
            >
              {mode === "login"
                ? "New here? Create an account"
                : "Back to sign in"}
            </button>
            {mode === "login" && (
              <button
                type="button"
                className="text-button"
                onClick={() => setMode("confirm")}
              >
                Already have a verification code?
              </button>
            )}
          </form>
        )}
      </section>
    </div>
  );
}
