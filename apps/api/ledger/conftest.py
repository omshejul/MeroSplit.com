import pytest
from django.core.cache import cache


@pytest.fixture(autouse=True)
def isolate_auth_rate_limits():
    cache.clear()
    yield
    cache.clear()
