// @vitest-environment jsdom
import "../../test/setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AwsSdkSetupFlow from "./AwsSdkSetupFlow";
import type { ProviderStatus } from "./ProviderCard";
import type { ProviderUIConfig } from "./providerConfig";

const bedrockProvider: ProviderUIConfig = {
  id: "amazon-bedrock",
  name: "Amazon Bedrock",
  tier: 3,
  icon: "cloud",
  primaryAuthType: "aws_sdk",
  guidedSetup: { status: "available", authTypes: ["aws_sdk"] },
  consoleUrl: "https://console.aws.amazon.com/bedrock",
  signupUrl: "https://aws.amazon.com/bedrock/",
  pricingNote: "AWS usage-based billing.",
  freeTier: null,
  description:
    "Uses AWS SDK credentials on the OpenClaw gateway host. Amazon Bedrock does not use an OAuth browser sign-in.",
  setupInstructions: [
    {
      stepNumber: 1,
      title: "Open AWS",
      detail: "Configure the AWS SDK default credential chain.",
      link: {
        url: "https://console.aws.amazon.com/bedrock",
        label: "Open Amazon Bedrock console",
      },
    },
  ],
  defaultModels: [],
};

const readyStatus: ProviderStatus = {
  id: "amazon-bedrock",
  status: "configured",
  authType: "aws_sdk",
  profileId: null,
  currentModel: null,
  isDefault: false,
  error: null,
  cooldownUntil: null,
  lastUsed: null,
  expiresAt: null,
  warning: null,
  readiness: {
    state: "ready",
    checkedAt: "2026-07-20T23:00:00.000Z",
    cached: false,
    availableModelCount: 2,
    message: "Read-only discovery found 2 usable Bedrock models.",
  },
};

describe("AwsSdkSetupFlow", () => {
  it("explains the external AWS credential boundary and never renders an OAuth or credential form", () => {
    render(<AwsSdkSetupFlow provider={bedrockProvider} onCancel={vi.fn()} />);

    expect(
      screen.getByRole("heading", { name: "Connect Amazon Bedrock" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Amazon Bedrock is not an OAuth provider"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Portal deliberately does not collect AWS account access keys/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/AWS_BEARER_TOKEN_BEDROCK/i)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign in/i }),
    ).not.toBeInTheDocument();
  });

  it("links to the real AWS console and provides exact OpenClaw verification commands", () => {
    render(<AwsSdkSetupFlow provider={bedrockProvider} onCancel={vi.fn()} />);

    expect(
      screen.getByRole("link", { name: /Open Amazon Bedrock console/i }),
    ).toHaveAttribute("href", "https://console.aws.amazon.com/bedrock");
    expect(
      screen.getByText(
        /openclaw plugins install --pin @openclaw\/amazon-bedrock-provider/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/openclaw models list --provider amazon-bedrock/i),
    ).toBeInTheDocument();
  });

  it("closes without claiming the provider was connected", () => {
    const onCancel = vi.fn();
    render(<AwsSdkSetupFlow provider={bedrockProvider} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(/connected successfully/i),
    ).not.toBeInTheDocument();
  });

  it("surfaces read-only readiness and lets the user force a fresh check", () => {
    const onRefresh = vi.fn();
    render(
      <AwsSdkSetupFlow
        provider={bedrockProvider}
        status={readyStatus}
        onRefresh={onRefresh}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Amazon Bedrock is ready")).toBeInTheDocument();
    expect(
      screen.getByText("Read-only discovery found 2 usable Bedrock models."),
    ).toBeInTheDocument();
    expect(screen.getByText(/fresh result/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
