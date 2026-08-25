import uvicorn

if __name__ == "__main__":
    uvicorn.run("graph_agent.api.server:app", host="0.0.0.0", port=8000)
