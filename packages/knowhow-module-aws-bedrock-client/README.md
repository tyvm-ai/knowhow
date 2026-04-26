# @tyvm/knowhow-module-aws-bedrock-client

AWS Bedrock AI client module for [@tyvm/knowhow](https://github.com/tyvm/knowhow).

Adds Amazon Bedrock foundation model access to knowhow via the **Converse API**, supporting chat completions, tool use, and model discovery across all Bedrock-supported models.

## Models Supported

- **Anthropic Claude** — claude-3-5-sonnet, claude-3-haiku, claude-3-opus
- **Meta Llama** — llama-3.1-405b, llama-3.1-70b, llama-3.3-70b
- **Amazon Nova** — nova-pro, nova-lite, nova-micro
- **Amazon Titan** — titan-text-premier, titan-embed-text
- **Mistral** — mistral-large, mistral-small, mixtral-8x7b
- **Cohere Command** — command-r-plus, command-r
- **Stability AI** — stable-diffusion-xl, stable-image-core/ultra

## Installation

```bash
npm install @tyvm/knowhow-module-aws-bedrock-client
```

## Setup

### 1. Add to knowhow config

In your `knowhow.config.json`:

```json
{
  "modules": ["@tyvm/knowhow-module-aws-bedrock-client"]
}
```

### 2. Configure AWS credentials

The module uses the standard AWS credential chain. Set one of:

**Option A: Environment variables**
```bash
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_REGION=us-east-1
```

**Option B: AWS profile**
```bash
export AWS_PROFILE=my-profile
export AWS_REGION=us-east-1
```

**Option C: IAM Role** (when running on EC2, ECS, Lambda, etc.)  
No configuration needed — the credential chain picks up the role automatically.

### 3. Enable Bedrock model access

In the [AWS Console](https://console.aws.amazon.com/bedrock/home#/modelaccess), enable access to the foundation models you want to use.

## Usage

Once configured, models are available under the `bedrock` provider:

```bash
knowhow chat --provider bedrock --model anthropic.claude-3-5-sonnet-20241022-v2:0
```

Or in agent config:
```json
{
  "model": "anthropic.claude-3-5-sonnet-20241022-v2:0",
  "provider": "bedrock"
}
```

## Common Model IDs

| Model | ID |
|-------|----|
| Claude 3.5 Sonnet | `anthropic.claude-3-5-sonnet-20241022-v2:0` |
| Claude 3.5 Haiku | `anthropic.claude-3-5-haiku-20241022-v1:0` |
| Claude 3 Haiku | `anthropic.claude-3-haiku-20240307-v1:0` |
| Llama 3.3 70B | `meta.llama3-3-70b-instruct-v1:0` |
| Llama 3.1 405B | `meta.llama3-1-405b-instruct-v1:0` |
| Amazon Nova Pro | `amazon.nova-pro-v1:0` |
| Amazon Nova Lite | `amazon.nova-lite-v1:0` |
| Amazon Nova Micro | `amazon.nova-micro-v1:0` |
| Mistral Large | `mistral.mistral-large-2402-v1:0` |
| Titan Embeddings v2 | `amazon.titan-embed-text-v2:0` |

## Why a Module (not baked-in)?

AWS Bedrock requires `@aws-sdk/client-bedrock-runtime` and `@aws-sdk/client-bedrock` as dependencies. These are large packages (~10MB) that most knowhow users don't need. Using a module keeps the core knowhow package lean — only install this if you need Bedrock.

## Region Support

Set `AWS_REGION` to the AWS region where you have Bedrock access. Available regions include:
- `us-east-1` (default, US East N. Virginia)
- `us-west-2` (US West Oregon)
- `eu-west-1` (EU Ireland)
- `ap-northeast-1` (Asia Pacific Tokyo)

Not all models are available in all regions. See [AWS Bedrock supported regions](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-regions.html).
