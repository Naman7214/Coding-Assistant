sequenceDiagram
    participant U as User
    participant UI as React UI
    participant Ext as Extension
    participant CC as Context Collector
    participant Agent as Coding Agent
    participant MCP as MCP Server
    participant Tools as FastAPI Tools
    participant State as State Manager
    
    U->>UI: Submit Query
    UI->>Ext: Send Query Event
    Ext->>CC: Trigger Context Collection
    CC->>CC: Gather VS Code Context
    CC->>State: Store Context
    Ext->>Agent: Send Query + Context
    Agent->>Agent: Forward to Anthropic
    
    loop Tool Execution Loop
        Agent->>Agent: Analyze & Plan
        Agent->>MCP: Request Tool Execution
        MCP->>Tools: Execute Specific Tool
        Tools->>Tools: Perform Operation
        Tools->>MCP: Return Result
        MCP->>Agent: Forward Result
        Agent->>Agent: Process Result
        Agent->>Agent: Evaluate Progress
    end
    
    Agent->>Agent: Final Response
    Agent->>Ext: Return Response
    Ext->>State: Update State
    Ext->>UI: Send Response
    UI->>U: Display Result