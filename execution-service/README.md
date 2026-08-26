# Aventa execution service

This directory is an isolated AWS Lambda signing boundary for Aventa. It is not activated merely by existing in the repository. Live execution starts only after the stack is deployed, the Sites server has an IAM caller credential, a user completes both wallet-signing enrollment steps, and the deployment is deliberately moved from `off` to `canary` or `limited_live` with `OPENS_ENABLED=true`.

The service targets the Robinhood Lighter endpoint and pins the official Python signer to `lighter-sdk==1.1.2`. It never accepts an Ethereum private key. A user signs the unmodified Lighter-generated UTF-8 `messageToSign` with their wallet so `personal_sign` and server recovery agree. The generated Lighter API private key is encrypted by the stack's customer-managed KMS key; only ciphertext is stored in DynamoDB.

## Security boundary

- Lambda Function URL authentication is `AWS_IAM`; there is no public `NONE` mode.
- The CloudFormation resource policy allows exactly one dedicated IAM user ARN. The handler checks the same `userArn` again.
- The Sites server must authenticate Privy, resolve the verified primary wallet server-side, and SigV4-sign the Lambda request. Browsers must never receive the AWS access key.
- Account index, API-key index, market index, Lighter chain ID, fee, and treasury are server-controlled. Request bodies containing overrides are rejected recursively.
- Treasury is fixed in code to account `17005`, owner `0xCe8756522C90B405c9647aE6BbcA169240965225`. The service verifies that ownership against the live venue before approval or fee-bearing execution.
- Integrator fees are fixed to `1700` Lighter fee units (0.17%) for maker and taker orders. `$100.00` notional therefore estimates a `$0.17` fee.
- The only signing operations exposed are create order, cancel, cancel-all, reduce-only close, USDG perps withdrawal, leverage update, API-key enrollment, and integrator approval. There is no transfer, key export, arbitrary destination, arbitrary transaction, or arbitrary market-index route.
- A DynamoDB conditional request record provides at-most-once idempotency. A conditional nonce lease serializes every Lighter API key. Ambiguous network outcomes become `UNKNOWN`, quarantine the nonce lane, and are automatically reconciled from the pre-broadcast signed transaction hash plus authoritative venue nonce. They are never blindly resubmitted.
- `OPENS_ENABLED=false`, capacity limits, or an execution-mode gate block new/increase orders. `EXIT_ONLY_ENABLED=true` independently preserves cancel, reduce-only close, and withdrawal. Withdrawals are additionally blocked until every position is flat and every order is cancelled.

## Wallet execution authorization

Every `order`, `cancel`, `cancel-all`, `close`, and `withdraw` request includes an `authorization` object:

```json
{
  "walletAddress": "0x...",
  "issuedAt": 1787558400000,
  "expiresAt": 1787558430000,
  "signature": "0x..."
}
```

The wallet signs this exact EIP-191 message (there is no trailing newline):

```text
Aventa Execution Authorization
Version: 1
Audience: aventa-execution-v1
Venue: Robinhood Lighter
Execution Chain ID: 466324
Fee Policy: 2026-08-24/17-bps
Chain ID: 4663
Action: <order|cancel|cancel-all|close|withdraw>
Request ID: <Idempotency-Key lowercased>
Issued At: <integer milliseconds>
Expires At: <integer milliseconds>
Payload: <canonical JSON excluding authorization>
```

Canonical JSON recursively sorts object keys and uses comma/colon separators without whitespace. The lifetime must be at most 30 seconds. The recovered signer must equal both the profile-bound wallet and the wallet verified by the Sites server. The request ID, action, timing, and canonical payload make the signature unusable for another request.

Idempotency compares only the canonical economic payload (the request without `authorization`). A repeat using the same lowercased `Idempotency-Key` and the same economic payload returns the original request even when the short-lived authorization has changed or expired. Reusing that key for a different economic payload returns `409 IDEMPOTENCY_CONFLICT`.

## Routes

All routes require SigV4 plus `x-aventa-user-id` and `x-aventa-wallet-address`. Every POST also requires `Idempotency-Key`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/v1/readiness` | User-specific mode, signer, treasury, fee, and risk readiness |
| `POST` | `/v1/enrollment/key/prepare` | Generate an API key and return the Lighter L1 message |
| `POST` | `/v1/enrollment/key/complete` | Recover the wallet signature and submit `ChangePubKey` |
| `POST` | `/v1/enrollment/integrator/prepare` | Return the exact 0.17% treasury approval message |
| `POST` | `/v1/enrollment/integrator/complete` | Recover and submit the approval |
| `POST` | `/v1/orders` | Market or limit open/increase order |
| `POST` | `/v1/orders/cancel` | Cancel one venue order ID |
| `POST` | `/v1/orders/cancel-all` | Cancel all, optionally for one allowlisted symbol |
| `POST` | `/v1/positions/close` | Refetch, clamp, and submit a reduce-only market close |
| `POST` | `/v1/withdrawals` | Withdraw USDG perps balance to the account's verified wallet after exposure checks |
| `GET` | `/v1/activity?limit=50` | Authoritative positions, orders, fills, withdrawals, and execution request log |
| `GET` | `/v1/requests/{requestId}` | Idempotency/request status |

The exact dynamically-resolved venue symbols are `BTC`, `ETH`, `XRP`, `SOL`, `SUI`, `AAPL`, `MSFT`, `NVDA`, `AMZN`, `GOOGL`, `META`, `TSLA`, `AMD`, and `COIN`. Market IDs are never hardcoded or accepted from callers. Crypto is capped at 15x; ordinary shares at 5x; `TSLA`, `AMD`, and `COIN` at 3x. Similar-but-not-identical ETF proxies are deliberately excluded.

## State layout

One provisioned DynamoDB table plus its chronological activity index (each 5 RCU / 10 WCU; aggregate 10/20 remains below the commonly documented 25/25 free-tier allowance when the AWS account is eligible) stores:

- `USER#<sha256 Privy DID> / PROFILE`
- `USER#<sha256 Privy DID> / CHALLENGE#<id>`
- `USER#<sha256 Privy DID> / REQ#<idempotency key>`
- `ACCOUNT#<account>#KEY#<key> / NONCE`
- `SYSTEM#ENROLLMENT / COUNT`

The raw Privy DID and API private key are not stored in DynamoDB. Signing challenges expire after 10 minutes; idempotency requests are retained for one year by default. Execution history and nonce state are authoritative here, not in browser storage or Sites D1.

## Build and deploy

The signer wheel contains a Linux native library. Build on Linux or use SAM's Linux build container; do not upload dependencies produced by a normal Windows `pip install`.

For the recommended Windows workflow without Docker, use AWS CloudShell and follow [DEPLOYMENT.md](DEPLOYMENT.md). CloudShell and the Lambda Python 3.12 runtime are both based on Amazon Linux 2023, and CloudShell includes the AWS CLI and SAM CLI. Keep the first deployment in `off` mode with opens disabled.

The pinned manifest is duplicated at the directory root for local tooling and under `src/` because SAM resolves Python dependencies from the function `CodeUri`. Keep those two two-line pins identical.

```bash
cd execution-service
sam build --use-container --template-file template.yaml
sam deploy --guided --parameter-overrides \
  AllowedInvokerArn=arn:aws:iam::<account-id>:user/aventa-sites-execution \
  ExecutionMode=off OpensEnabled=false ExitOnlyEnabled=true
```

Create a dedicated IAM user for the Sites backend with only `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on the output function ARN, constrained to invocation through the function URL. Put that user's access key only in encrypted Sites server secrets.

Recommended activation sequence:

1. Deploy with `ExecutionMode=off`, `OpensEnabled=false`, and `ExitOnlyEnabled=true`.
2. Configure Sites SigV4 and confirm `/v1/readiness` works.
3. Add only operator test-user hashes to `CanaryUserHashes`; deploy `ExecutionMode=canary` while opens remain off.
4. Complete key and integrator wallet signatures, then exercise cancel, close, and a minimum-size withdrawal on a funded test account.
5. Force a test timeout and verify request-driven transaction/nonce reconciliation releases the quarantined lane before enabling opens.
6. Use `limited_live` only after the canary is reviewed. Keep the enrollment cap at 450 to remain below Privy's current free-tier boundary.

AWS free-tier eligibility is account- and usage-dependent and is not a cost guarantee. Configure AWS Budgets and billing alerts before canary activation. The ZIP Lambda and conservative provisioned DynamoDB capacity avoid a paid container registry; the customer-managed KMS key is a deliberate security cost.

## Tests

Pure policy, validation, authorization-message, and idempotency tests do not need AWS credentials:

```bash
python -m unittest discover -s tests -v
python -m compileall src tests
```

`SUBMITTED` means the venue acknowledged submission; it never means filled. `UNKNOWN` is reconciled automatically when readiness, activity, or request status is read. It must not be retried with a new request ID while still unknown.
