import importlib.util
import json
import os
import shutil
import zipfile
from pathlib import Path

import pytest
from jsonschema import ValidationError

spec = importlib.util.spec_from_file_location("package_merosplit_plugin", Path(__file__).with_name("package-merosplit-plugin.py"))
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


@pytest.fixture
def package(tmp_path):
    path = tmp_path / "plugin"
    shutil.copytree(plugin.PACKAGE, path)
    return path


def edit(package, filename, update):
    path = package / filename
    data = json.loads(path.read_text())
    update(data)
    path.write_text(json.dumps(data))


def test_actual_schemas_and_honest_extension_limitation(package):
    report = plugin.validate(package)
    assert report["portable_manifest_schema"] == "passed"
    assert report["portable_mcp_core_schema"] == "passed"
    assert report["complete_mcp_schema"] == "rejected_documented_openai_extension"
    assert "not_official_extension_schema" in report["openai_fields"]
    # The declaration stays in the shipped file; core validation must not remove it.
    actual = json.loads((package / "mcp.json").read_text())
    assert actual["mcpServers"]["merosplit"]["extensions"]["com.openai"]["auth"] == plugin.AUTH
    with pytest.raises(ValidationError):
        plugin.official_schema("mcp.schema.json").validate(actual)


@pytest.mark.parametrize("change", [
    lambda server: server.update(headers={"Authorization": "Bearer should-not-ship"}),
    lambda server: server.update(url="https://other.invalid/mcp"),
    lambda server: server.update(command="run-local-service"),
    lambda server: server["extensions"]["com.openai"]["auth"].update(client={"mode": "provided", "clientId": "unexpected"}),
    lambda server: server["extensions"]["com.openai"]["auth"].update(baseScopes=["admin"]),
    lambda server: server["extensions"]["com.openai"]["auth"].update(clientSecret="should-not-ship"),
])
def test_contract_rejects_credentials_scope_drift_and_other_endpoints(package, change):
    edit(package, "mcp.json", lambda data: change(data["mcpServers"]["merosplit"]))
    with pytest.raises(ValueError, match="DCR"):
        plugin.validate(package)


def test_adapter_must_share_identity_and_endpoint(package):
    edit(package, ".mcp.json", lambda data: data["mcpServers"]["merosplit"].update(url="https://other.invalid/mcp"))
    with pytest.raises(ValueError, match="reuse"):
        plugin.validate(package)


@pytest.mark.parametrize("change", [
    lambda extension: extension["interface"].update(termsOfServiceURL="http://other.invalid/terms"),
    lambda extension: extension["interface"].update(shortDescription="x" * 31),
    lambda extension: extension["interface"].update(logo="../../outside.png"),
    lambda extension: extension["review"]["test_cases"]["positive"].pop(),
    lambda extension: extension["review"]["test_cases"]["negative"][0].update(password="must-not-ship"),
])
def test_listing_and_review_materials_are_complete_and_bounded(package, change):
    edit(package, "plugin.json", lambda data: change(data["extensions"]["com.openai"]))
    with pytest.raises(ValueError):
        plugin.validate(package)


def test_package_excludes_unreviewed_files_and_symlinks(package, tmp_path):
    extra = package / ".env"
    extra.write_text("synthetic-private-material")
    with pytest.raises(ValueError, match="inventory"):
        plugin.package_zip(package, tmp_path / "bad.zip")
    assert not (tmp_path / "bad.zip").exists()
    extra.unlink()
    (package / "README.md").unlink()
    (package / "README.md").symlink_to(plugin.PACKAGE / "README.md")
    with pytest.raises(ValueError, match="Symlinks"):
        plugin.validate(package)


def test_zip_is_reproducible_and_preserves_shared_skill_and_dotfile_adapter(package, tmp_path):
    first, second = tmp_path / "first.zip", tmp_path / "second.zip"
    a = plugin.package_zip(package, first)
    for path in package.rglob("*"):
        os.utime(path, (1900000000, 1900000000))
    b = plugin.package_zip(package, second)
    assert a["sha256"] == b["sha256"]
    assert first.read_bytes() == second.read_bytes()
    with zipfile.ZipFile(first) as archive:
        assert set(archive.namelist()) == set(plugin.FILES)
        assert len([name for name in archive.namelist() if name.endswith("SKILL.md")]) == 1
        for name in plugin.FILES:
            assert archive.read(name) == (package / name).read_bytes()
        assert all(item.date_time == (1980, 1, 1, 0, 0, 0) for item in archive.infolist())


def test_invalid_manifest_and_presentation_are_not_accepted(package):
    edit(package, "plugin.json", lambda data: data.update(name="Invalid Name"))
    with pytest.raises(ValidationError):
        plugin.validate(package)
    edit(package, "plugin.json", lambda data: data.update(name="merosplit"))
    edit(package, "plugin.json", lambda data: data["extensions"]["com.openai"].update(hooks="./hooks.json"))
    with pytest.raises(ValueError, match="presentation"):
        plugin.validate(package)
