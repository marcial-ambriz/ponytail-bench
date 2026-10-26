from bench import blind


def test_blind_code_strips_arm_tells():
    src = "\n".join([
        "const x = 1; // ponytail: skipped cache, add when needed",
        "# ponytail: lazy",
        "// keeps a steady log",
        "function ok() { return 1 }",
        "Goal: cache API responses.",
        "Items: cache (done).",
        "Assumptions: in-memory.",
        "Open points: none.",
    ])
    out = blind.blind_text(src)
    assert "ponytail" not in out.lower() and "steady" not in out.lower()
    assert "const x = 1;" in out and "function ok()" in out
    assert "Goal:" not in out and "Open points:" not in out


def test_blind_text_masks_run_ids_and_branch_names():
    out = blind.blind_text("see run/p1-invoicing-sonnet-ponytail-r2/cp3 and p1-invoicing-luna-base-r1")
    assert "sonnet" not in out and "ponytail" not in out and "luna" not in out


def test_scrub_removes_home_paths_tokens_and_host():
    import os
    import socket
    home = os.path.expanduser("~")
    text = (f"cwd {home}/Projects/x token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 key sk-proj-ABCDEFGHIJKLMNOPQRSTUV "
            f"host {socket.gethostname()} Bearer eyJhbGciOiJIUzI1NiJ9.abc.def")
    out = blind.scrub(text)
    assert home not in out and "~/Projects/x" in out
    assert "sk-ant-api03" not in out and "sk-proj-" not in out and "eyJhbGci" not in out
    assert socket.gethostname() not in out


def test_export_refuses_credential_files(tmp_path):
    (tmp_path / "auth.json").write_text("{}")
    (tmp_path / "t.jsonl").write_text("ok")
    out = tmp_path / "out"
    copied = blind.export_scrubbed(tmp_path, out)
    assert [p.name for p in copied] == ["t.jsonl"]
