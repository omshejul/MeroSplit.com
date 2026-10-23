from allauth.account.adapter import DefaultAccountAdapter


class EmailCodeAccountAdapter(DefaultAccountAdapter):
    def authenticate(self, request, **credentials):
        return None  # Password login is no longer an accepted authentication method.

    def is_open_for_signup(self, request):
        return False  # Registration occurs only after the database-backed OTP verifies.
