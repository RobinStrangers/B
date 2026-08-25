from __future__ import annotations


class ServiceError(Exception):
    """An expected error that is safe to expose as a stable code."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        http_status: int = 400,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.retryable = retryable


class VenueRejected(ServiceError):
    def __init__(self, message: str, *, code: str = "VENUE_REJECTED") -> None:
        super().__init__(code, message, http_status=422, retryable=False)


class VenueAmbiguous(ServiceError):
    """The signer cannot prove whether the venue accepted the transaction."""

    def __init__(self, message: str = "Venue submission outcome is unknown") -> None:
        super().__init__(
            "VENUE_OUTCOME_UNKNOWN",
            message,
            http_status=202,
            retryable=False,
        )

