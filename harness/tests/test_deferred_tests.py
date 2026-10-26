from bench import validator

tests_due = validator.tests_due
tests_due.__test__ = False


def rec(acceptance=("pass",), booted=True, errors=()):
    return {"booted": booted, "setup_ok": True, "runner_errors": list(errors),
            "acceptance": [{"id": f"t{i}", "status": s} for i, s in enumerate(acceptance)]}


def test_own_tests_always_run_when_not_deferred():
    assert tests_due(False, rec(acceptance=("fail",)))


def test_deferred_own_tests_run_once_acceptance_is_green():
    assert tests_due(True, rec(acceptance=("pass", "passed")))


def test_deferred_own_tests_wait_while_acceptance_fails():
    assert not tests_due(True, rec(acceptance=("pass", "fail")))
    assert not tests_due(True, rec(acceptance=()))
    assert not tests_due(True, rec(booted=False))
    assert not tests_due(True, rec(errors=("runner crashed",)))


def test_final_validation_always_runs_deferred_tests():
    # an exhausted checkpoint still gets its own tests, so the lint/test cap is scored exactly as before
    assert tests_due(True, rec(acceptance=("fail",)), final=True)
