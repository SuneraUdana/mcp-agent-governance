import os
import uuid

import gradio as gr
import requests

API_URL = os.getenv("DEMO_API_URL", "http://localhost:3000").rstrip("/")


def invoke_demo(agent_id: str, credential_id: str, secret: str, message: str) -> str:
    if not all([agent_id, credential_id, secret]):
        return "Provide the seeded agent ID, credential ID, and one-time secret."
    correlation_id = f"gradio-{uuid.uuid4()}"
    response = requests.post(
        f"{API_URL}/v1/mcp/invoke",
        headers={
            "authorization": f"Bearer {secret}",
            "content-type": "application/json",
            "x-correlation-id": correlation_id,
        },
        json={
            "agentId": agent_id,
            "toolId": "demo-tool",
            "credentialId": credential_id,
            "payload": {"message": message or "hello from Gradio"},
        },
        timeout=10,
    )
    return f"HTTP {response.status_code}\n{response.text}"


with gr.Blocks(title="Agent Governance Demo") as demo:
    gr.Markdown(
        "# AI Agent Identity & Governance\n"
        "Enter the one-time values printed by `npm run demo:seed`. "
        "The API validates the credential and policy before calling the external demo tool."
    )
    with gr.Row():
        agent_id = gr.Textbox(label="Agent ID", value="demo-agent")
        credential_id = gr.Textbox(label="Credential ID")
    secret = gr.Textbox(label="One-time credential secret", type="password")
    message = gr.Textbox(label="Tool message", value="hello from Gradio")
    invoke = gr.Button("Invoke governed tool", variant="primary")
    result = gr.Code(label="Invocation result", language="json")
    invoke.click(invoke_demo, [agent_id, credential_id, secret, message], result)


if __name__ == "__main__":
    demo.launch()
