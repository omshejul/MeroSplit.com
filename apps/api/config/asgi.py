"""One service: Django owns browser/API routes and the SDK owns stateless /mcp."""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")


class MeroSplitApplication:
    def __init__(self):
        self.django = get_asgi_application()
        from ledger.mcp_server import create_mcp_app
        self.mcp = create_mcp_app()

    async def __call__(self, scope, receive, send):
        # The SDK lifespan is entered once per worker, not once per RPC request.
        if scope["type"] == "lifespan" or scope.get("path") == "/mcp":
            return await self.mcp(scope, receive, send)
        return await self.django(scope, receive, send)


application = MeroSplitApplication()
