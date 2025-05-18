from fastapi import APIRouter, Depends

from src.app.controllers.enviornment_tools.run_terminal_cms_controller import (
    RunTerminalCmdController,
)
from src.app.models.schemas.run_terminal_command_schema import (
    RunTerminalCommandRequest,
)

router = APIRouter()


@router.post("/run-terminal-cmd")
async def run_terminal_cmd(
    request: RunTerminalCommandRequest,
    run_terminal_cmd_controller: RunTerminalCmdController = Depends(
        RunTerminalCmdController
    ),
):
    return await run_terminal_cmd_controller.run_terminal_cmd(request)
