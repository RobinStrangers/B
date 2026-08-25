# AWS deployment runbook

This runbook is deliberately build-and-review first. It does not make the execution service live until the final `sam deploy` command is explicitly run. The safest Docker-free workflow from Windows is to build in AWS CloudShell: CloudShell is Amazon Linux 2023, as is the Lambda Python 3.12 runtime, and it includes both AWS CLI and SAM CLI.

## Before using AWS credits

1. In **Billing and Cost Management > Credits**, confirm the remaining amount, eligible services, and expiry date. Promotional credits apply only to eligible charges and expire independently of this stack.
2. Enable AWS Free Tier usage alerts.
3. Create a monthly AWS Budget with alerts at `$5`, `$10`, and `$20`. Budget monitoring is free; the first two action-enabled budgets are also free.
4. Choose one AWS Region and keep the stack, SAM artifact bucket, and caller configuration there. The examples below use `us-east-1`; change every occurrence together if another Region is chosen.

## 1. Prepare the source on Windows

In PowerShell, create a source-only archive:

```powershell
Set-Location C:\Users\user\Downloads\b20-launchpad
Compress-Archive -Path .\execution-service\* -DestinationPath .\aventa-execution-source.zip -CompressionLevel Optimal
```

Open AWS CloudShell in the intended Region, choose **Actions > Upload file**, and upload `aventa-execution-source.zip`.

## 2. Build and validate in CloudShell without Docker

Run these commands in CloudShell. They stop if CloudShell is not x86_64, because the SAM template deliberately targets Lambda x86_64.

```bash
set -euo pipefail

export AWS_REGION=us-east-1
test "$(uname -m)" = "x86_64" || {
  echo "This build requires an x86_64 CloudShell environment."
  exit 1
}

sudo dnf install -y python3.12 python3.12-pip
python3.12 --version
sam --version
aws --version

mkdir -p "$HOME/aventa-execution-source"
unzip -q "$HOME/aventa-execution-source.zip" -d "$HOME/aventa-execution-source"
cd "$HOME/aventa-execution-source"

diff -u \
  <(grep -E '^[A-Za-z0-9_-]+==' requirements.txt) \
  <(grep -E '^[A-Za-z0-9_-]+==' src/requirements.txt)

PYTHONPATH=src python3.12 -m unittest discover -s tests -v
python3.12 -m compileall -q src tests
sam validate --lint --template-file template.yaml
sam build --no-use-container --template-file template.yaml

BUILD_DIR=.aws-sam/build/ExecutionFunction
SIGNER="$BUILD_DIR/lighter/signers/lighter-signer-linux-amd64.so"
test -f "$SIGNER"
file "$SIGNER"
python3.12 -c "import ctypes; ctypes.CDLL('$SIGNER'); print('native signer load: PASS')"

UNZIPPED_BYTES=$(du -sb "$BUILD_DIR" | cut -f1)
echo "uncompressed deployment bytes: $UNZIPPED_BYTES"
test "$UNZIPPED_BYTES" -lt 262144000 || {
  echo "Deployment exceeds Lambda's 250 MiB uncompressed limit."
  exit 1
}
```

Do not replace this with a normal Windows `sam build`: `lighter-sdk`, `aiohttp`, `pydantic-core`, and other dependencies contain native binaries. The locally audited Linux x86_64 dependency set was approximately `121.24 MiB` uncompressed and `53.99 MiB` compressed before optional pruning. It is below Lambda's 250 MiB uncompressed limit but above the 50 MB direct-upload limit, so deployment must use SAM's S3 artifact path via `--resolve-s3`.

The exact Lighter wheel includes `lighter-signer-linux-amd64.so` as a 64-bit x86-64 ELF binary. It also includes unused Windows, macOS, and ARM signer files. They can be pruned later through a reviewed reproducible build step, but package-size optimization is not required for the first fail-closed deployment.

## 3. Create the dedicated caller principal

Create the user before the stack because the Lambda resource policy is restricted to its exact ARN:

```bash
aws iam create-user --user-name aventa-sites-execution
export INVOKER_ARN=$(aws iam get-user \
  --user-name aventa-sites-execution \
  --query 'User.Arn' \
  --output text)
echo "$INVOKER_ARN"
```

Do not create an access key yet. Create it only when the Sites backend secret store is ready, copy it directly into encrypted server-side secrets, and never expose it to browser JavaScript or commit it to the repository.

## 4. Review and deploy in fail-closed mode

The first deployment must remain non-executing:

```bash
sam deploy --guided \
  --template-file .aws-sam/build/template.yaml \
  --stack-name aventa-execution-prod \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides \
    AllowedInvokerArn="$INVOKER_ARN" \
    ExecutionMode=off \
    OpensEnabled=false \
    ExitOnlyEnabled=true \
    MaximumEnrolledUsers=450 \
    MaximumNotionalUsd=25000 \
    SsmParameterPrefix=/aventa/execution/prod/
```

At the guided prompts:

- require change-set confirmation;
- allow SAM to create the IAM execution role;
- do not disable rollback;
- save the configuration only if `samconfig.toml` will be treated as deployment configuration and reviewed before commit.

Retrieve the outputs after CloudFormation completes:

```bash
export FUNCTION_URL=$(aws cloudformation describe-stacks \
  --stack-name aventa-execution-prod \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ExecutionFunctionUrl'].OutputValue" \
  --output text)

export FUNCTION_ARN=$(aws cloudformation describe-stacks \
  --stack-name aventa-execution-prod \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ExecutionFunctionArn'].OutputValue" \
  --output text)

echo "$FUNCTION_URL"
echo "$FUNCTION_ARN"
```

## 5. Attach the caller's least-privilege identity policy

The function resource policy is already restricted to the caller ARN. Add the matching identity policy with both permissions required by new Function URLs:

```bash
CALLER_POLICY=$(jq -nc --arg arn "$FUNCTION_ARN" '{
  Version:"2012-10-17",
  Statement:[
    {
      Sid:"InvokeAventaFunctionUrl",
      Effect:"Allow",
      Action:"lambda:InvokeFunctionUrl",
      Resource:$arn,
      Condition:{StringEquals:{"lambda:FunctionUrlAuthType":"AWS_IAM"}}
    },
    {
      Sid:"InvokeOnlyViaFunctionUrl",
      Effect:"Allow",
      Action:"lambda:InvokeFunction",
      Resource:$arn,
      Condition:{Bool:{"lambda:InvokedViaFunctionUrl":"true"}}
    }
  ]
}')

aws iam put-user-policy \
  --user-name aventa-sites-execution \
  --policy-name AventaExecutionFunctionUrlOnly \
  --policy-document "$CALLER_POLICY"
```

Verify that the endpoint stayed IAM-only and that both resource-policy statements exist:

```bash
FUNCTION_NAME=${FUNCTION_ARN##*:}
aws lambda get-function-url-config \
  --function-name "$FUNCTION_NAME" \
  --region "$AWS_REGION" \
  --query '{AuthType:AuthType,FunctionUrl:FunctionUrl}'

aws lambda get-policy \
  --function-name "$FUNCTION_NAME" \
  --region "$AWS_REGION" \
  --query Policy \
  --output text | jq .

curl -sS -o /dev/null -w 'unsigned HTTP status: %{http_code}\n' \
  "${FUNCTION_URL%/}/v1/readiness"
```

The unsigned request must return `403`. Do not continue if it returns any public success response.

## 6. Create and store the caller key

When the backend's encrypted secret storage is ready:

```bash
aws iam create-access-key --user-name aventa-sites-execution
```

The secret access key is shown only once. Store both values immediately as backend-only secrets, clear the terminal, and do not save them in CloudShell home storage. Rotate the key if it is ever displayed in logs or exposed to a browser.

The Sites backend must SigV4-sign against service `lambda` and the same Region as the function. A valid request additionally supplies the verified `x-aventa-user-id` and `x-aventa-wallet-address` headers. Every POST also supplies `Idempotency-Key`.

## 7. Activation gates

Deployment is not live execution. Keep these gates until the preceding layer is verified:

1. `ExecutionMode=off`, `OpensEnabled=false`: verify IAM, route handling, DynamoDB, logs, and treasury readiness.
2. `ExecutionMode=canary`, `OpensEnabled=false`: enroll only explicit hashed test users and verify key/integrator signing plus cancel and close behavior.
3. `ExecutionMode=canary`, `OpensEnabled=true`: permit low-notional operator trades only after `UNKNOWN` outcome reconciliation and monitoring are operational.
4. Move to `limited_live` only after the canary is reviewed.

Never switch directly from `off` to `limited_live`.

## Cost and cleanup notes

At the template defaults, the base table plus activity index provision a combined `10 RCU` and `20 WCU`. This is within DynamoDB's documented monthly free-tier allocation of `25 RCU`, `25 WCU`, and `25 GB` for eligible accounts. If that free allocation is unavailable or already consumed elsewhere, current US East example rates imply roughly `$10.44/month` for this provisioned capacity (`10 × $0.00013 + 20 × $0.00065`, multiplied by about 730 hours), before credits.

At low traffic, the expected eligible-account baseline is approximately `$0/month`:

- Lambda: 1 million requests and 400,000 GB-seconds per month are in the free tier; Function URLs have no separate endpoint fee.
- Parameter Store Standard: no additional charge; the service explicitly writes Standard parameters.
- AWS managed `aws/ssm` encryption: no additional key charge.
- CloudWatch Logs: the first 5 GB is in the free tier.
- CloudShell: no additional charge.
- CloudFormation and IAM: no separate resource charge.
- SAM's managed S3 artifact bucket is small but not inherently free forever; repeated deployment artifacts accumulate and should be reviewed periodically.

The `$100` credit balance is a buffer, not a spending control. At an uncovered DynamoDB baseline of about `$10.44/month`, it represents less than ten months before Lambda, log, S3, data-transfer, tax, or unrelated account usage, and the credit may expire earlier.

The table uses `DeletionPolicy: Retain`, and runtime-created SSM keys are not CloudFormation resources. Deleting the stack therefore does **not** delete user execution state, SSM signer keys, the dedicated IAM user/access keys, or SAM artifacts. Cleanup must be a separate, explicitly reviewed procedure; never assume stack deletion removes sensitive execution material.

## Remaining production blockers

- AWS credit eligibility and expiry must be confirmed in the actual account.
- Transitive Python dependencies are not fully locked with hashes; the two direct dependencies are pinned, but a production release should use a reviewed lock artifact for reproducible builds.
- CloudShell `sam validate --lint`, native signer loading, and the built artifact size must pass in the target Region/account.
- The exact IAM caller must be integrated into encrypted Sites backend secrets and tested with SigV4.
- User Lighter key and integrator enrollments require real wallet signatures and cannot be completed by deployment automation.
- There is no automatic venue reconciliation worker for `UNKNOWN` requests yet; live opens must remain disabled until an operator process exists.
- Billing alerts, execution alerts, access-key rotation, and incident response must be configured before public launch.
