import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .auth import SESSION_COOKIE, _user_for_token
from .engine_manager import manager
from .engine_settings import get_effective_settings

router = APIRouter()


@router.websocket("/ws/live-eval")
async def live_eval(websocket: WebSocket):
    token = websocket.cookies.get(SESSION_COOKIE)
    user_row = _user_for_token(token)
    if not user_row:
        await websocket.close(code=4401)
        return
    user = dict(user_row)

    await websocket.accept()
    connection_id = str(uuid.uuid4())

    async def on_eval(seq, info):
        try:
            await websocket.send_json({"type": "info", "seq": seq, **info})
        except RuntimeError:
            pass  # socket already closing

    settings = get_effective_settings(user["id"])

    try:
        await manager.create_session(connection_id, user, settings, on_eval)
    except RuntimeError as e:
        await websocket.send_json({"type": "error", "message": str(e)})
        await websocket.close()
        return
    except Exception as e:  # engine failed to start (bad path, not executable, etc.)
        await websocket.send_json({"type": "error", "message": f"engine failed to start: {e}"})
        await websocket.close()
        return

    try:
        while True:
            msg = await websocket.receive_json()
            if msg.get("type") == "position":
                fen = msg.get("fen")
                seq = msg.get("seq")
                if fen and seq is not None:
                    manager.sessions[connection_id].request(fen, seq)
    except WebSocketDisconnect:
        pass
    finally:
        await manager.destroy_session(connection_id)
