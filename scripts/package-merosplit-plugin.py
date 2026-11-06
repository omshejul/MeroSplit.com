#!/usr/bin/env python3
"""Validate the reviewed remote plugin and produce a deterministic, secret-free ZIP."""

import argparse
import hashlib
import io
import json
import zipfile
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator
from PIL import Image

REPO = Path(__file__).resolve().parents[1]
PACKAGE = REPO / "plugins" / "merosplit"
SCHEMAS = Path(__file__).resolve().parent / "plugin-schemas"
ENDPOINT = "https://merosplit.com/mcp"
FILES = (
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "README.md",
    "mcp.json",
    "plugin.json",
    "skills/merosplit/SKILL.md",
    "assets/icon.png",
)
AUTH = {"type": "oauth", "client": {"mode": "dcr"}, "baseScopes": ["merosplit:mcp"]}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def official_schema(name):
    raw = (SCHEMAS / name).read_bytes()
    provenance = json.loads((SCHEMAS / "provenance.json").read_text())
    require(hashlib.sha256(raw).hexdigest() == provenance[name]["sha256"], f"Schema snapshot changed: {name}")
    schema = json.loads(raw)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def validate(package=PACKAGE):
    package = Path(package)
    require(package.is_dir() and not package.is_symlink(), "Package must be a real directory")
    paths = list(package.rglob("*"))
    require(not any(path.is_symlink() for path in paths), "Symlinks are not packaged")
    actual = {path.relative_to(package).as_posix() for path in paths if path.is_file()}
    require(actual == set(FILES), "Package file inventory differs from the reviewed allowlist")
    documents = {name: json.loads((package / name).read_text()) for name in FILES if name.endswith(".json")}
    manifest, mcp = documents["plugin.json"], documents["mcp.json"]
    official_schema("plugin.schema.json").validate(manifest)
    require(manifest["name"] == "merosplit" and manifest.get("version") == "0.1.1", "Unexpected package identity")
    require(set(manifest.get("extensions", {})) == {"com.openai"}, "Unexpected manifest extension")
    extension = manifest["extensions"]["com.openai"]
    require(set(extension) == {"interface", "review", "publication"}, "Only presentation, review and publication metadata is permitted")
    interface = extension["interface"]
    require(set(interface) == {"displayName", "shortDescription", "longDescription", "developerName", "category", "capabilities", "websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL", "defaultPrompt", "logo", "composerIcon"}, "Unexpected OpenAI presentation field")
    require(all(isinstance(interface[key], str) and interface[key] for key in interface if key not in {"capabilities", "defaultPrompt"}), "Presentation text must be nonempty")
    require(interface["capabilities"] == ["Read", "Write"], "Unexpected capabilities")
    require(isinstance(interface["defaultPrompt"], list) and all(isinstance(item, str) and item for item in interface["defaultPrompt"]), "Invalid default prompts")
    require(interface["websiteURL"] == "https://merosplit.com" and interface["privacyPolicyURL"] == "https://merosplit.com/privacy", "Unexpected public URLs")
    require(interface["supportURL"] == "https://merosplit.com/support" and interface["termsOfServiceURL"] == "https://merosplit.com/terms", "Unexpected support or terms URLs")
    require(len(interface["displayName"]) <= 30 and len(interface["shortDescription"]) <= 30 and len(interface["longDescription"]) <= 4000, "Listing text exceeds submission limits")
    require(1 <= len(interface["defaultPrompt"]) <= 3 and all(len(item) <= 128 for item in interface["defaultPrompt"]), "Starter prompt exceeds submission limits")
    require(interface["logo"] == interface["composerIcon"] == "./assets/icon.png", "Use the packaged icon")
    icon = package / "assets/icon.png"
    with Image.open(icon) as image:
        require(image.format == "PNG" and 48 <= image.width == image.height <= 4096 and icon.stat().st_size <= 5 * 1024 * 1024, "Invalid listing icon")
    review = extension["review"]
    require(set(review) == {"commerce", "test_cases"} and review["commerce"] is False, "Expected ledger-only review metadata")
    cases = review["test_cases"]
    require(set(cases) == {"positive", "negative"} and len(cases["positive"]) == 5 and len(cases["negative"]) == 3, "Review requires five positive and three negative cases")
    for kind, entries in cases.items():
        required = {"description", "prompt", "expected_behavior"} | ({"tools_triggered"} if kind == "positive" else set())
        for case in entries:
            require(set(case) == required and all(isinstance(value, str) and value.strip() for value in case.values()), "Incomplete review case")
    require(set(extension["publication"]) == {"release_notes"} and bool(extension["publication"]["release_notes"].strip()), "Release notes are required")
    require(set(mcp.get("mcpServers", {})) == {"merosplit"}, "One remote MCP server is required")
    server = mcp["mcpServers"]["merosplit"]
    require(server == {"type": "streamable-http", "url": ENDPOINT, "extensions": {"com.openai": {"auth": AUTH}}}, "Expected documented DCR auth only; no headers, credentials or processes")

    # Keep the actual package unchanged. The published generic schema currently
    # rejects OpenAI's documented extension; validate and report both facts.
    validator = official_schema("mcp.schema.json")
    whole_errors = list(validator.iter_errors(mcp))
    core = deepcopy(mcp)
    del core["mcpServers"]["merosplit"]["extensions"]
    validator.validate(core)
    claude = documents[".claude-plugin/plugin.json"]
    require(claude == {key: manifest[key] for key in ("name", "version", "description", "author", "homepage")}, "Claude adapter identity differs")
    require(documents[".mcp.json"] == {"mcpServers": {"merosplit": {"type": "http", "url": ENDPOINT}}}, "Claude adapter must reuse the same remote OAuth endpoint without credentials")
    skill = (package / "skills/merosplit/SKILL.md").read_text()
    require(skill.startswith("---\nname: merosplit\ndescription: ") and "\n---\n" in skill[4:], "Shared skill needs discoverable frontmatter")
    return {
        "portable_manifest_schema": "passed",
        "portable_mcp_core_schema": "passed",
        "complete_mcp_schema": "rejected_documented_openai_extension" if whole_errors else "passed",
        "openai_fields": "project_contract_checked_against_documentation_not_official_extension_schema",
        "claude_adapter": "same_endpoint_and_shared_skill_checked; run claude plugin validate separately",
        "public_review_remaining": ["verified publishing identity", "domain verification and live tool scan", "reviewer credentials", "host walkthrough recording"],
        "schema_sha256": {name: hashlib.sha256((SCHEMAS / name).read_bytes()).hexdigest() for name in ("plugin.schema.json", "mcp.schema.json")},
    }


def package_zip(package, output):
    package, output = Path(package), Path(output)
    report = validate(package)
    require(not output.resolve().is_relative_to(REPO), "ZIP output must stay outside the source repository")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(FILES):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, (package / name).read_bytes())
    data = buffer.getvalue()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(data)
    return {**report, "zip": str(output.resolve()), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "files": list(sorted(FILES))}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="ZIP destination outside the repository")
    args = parser.parse_args()
    print(json.dumps(package_zip(PACKAGE, args.output), indent=2))
