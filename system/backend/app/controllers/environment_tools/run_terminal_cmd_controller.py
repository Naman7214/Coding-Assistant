from fastapi import Depends, status
from fastapi.responses import JSONResponse

from system.backend.app.models.schemas.run_terminal_command_schema import (
    RunTerminalCommandRequest,
)
from system.backend.app.usecases.environment_tools.run_terminal_cmd_usecase import (
    RunTerminalCmdUsecase,
)


class RunTerminalCmdController:
    def __init__(
        self,
        run_terminal_cmd_usecase: RunTerminalCmdUsecase = Depends(
            RunTerminalCmdUsecase
        ),
    ):
        self.run_terminal_cmd_usecase = run_terminal_cmd_usecase

    async def run_terminal_cmd(self, request: RunTerminalCommandRequest):
        result = await self.run_terminal_cmd_usecase.run_terminal_command(
            request.cmd,
            request.is_background,
            request.explanation,
            request.workspace_path,
        )
        return JSONResponse(
            content={
                "data": result,
                "message": "Terminal command executed successfully",
                "error": None,
            },
            status_code=status.HTTP_200_OK,
        )
