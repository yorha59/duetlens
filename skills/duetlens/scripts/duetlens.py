#!/usr/bin/env python3
"""通过 Duetlens 分享端口读取会话或显式关联仓库；不使用 GUI、代理或数据库。"""
import hashlib
import argparse
import json
import re
import socket
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

TOKEN_PATH = re.compile(r"/sessions/[A-Za-z0-9_-]{43}")
MAX_RESPONSE = 32 * 1024 * 1024


class ClientError(Exception):
    pass


class ResponseError(ClientError):
    def __init__(self, status, message):
        self.status = status
        super().__init__(f"HTTP {status}: {message}")


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def session_url(value):
    try:
        url = urlsplit(value)
        port = url.port
    except ValueError as error:
        raise ClientError("无效分享链接") from error
    if (url.scheme != "http" or url.hostname != "127.0.0.1" or not port
            or url.username or url.password or url.query or url.fragment
            or not TOKEN_PATH.fullmatch(url.path)):
        raise ClientError("需要 http://127.0.0.1:端口/sessions/令牌 格式的会话链接")
    return f"http://127.0.0.1:{port}{url.path}"


class Client:
    def __init__(self, url, timeout=45):
        self.url = session_url(url)
        self.timeout = timeout
        self.opener = build_opener(ProxyHandler({}), NoRedirects())

    def get(self, url):
        base, target = urlsplit(self.url), urlsplit(url)
        if (target.scheme != base.scheme or target.netloc != base.netloc
                or target.path not in (base.path, base.path + "/file", base.path + "/diff")
                or target.fragment):
            raise ClientError("服务器返回了超出当前分享范围的链接，已停止读取")
        for attempt in range(2):
            try:
                req = Request(url, headers={"Accept": "application/json, text/plain", "User-Agent": "duetlens-skill/1"}, method="GET")
                with self.opener.open(req, timeout=self.timeout) as response:
                    data = response.read(MAX_RESPONSE + 1)
                    if len(data) > MAX_RESPONSE:
                        raise ClientError("响应超过 32 MiB，请缩小读取范围")
                    return data.decode("utf-8")
            except HTTPError as error:
                detail = error.read(4096).decode("utf-8", errors="replace")
                try:
                    detail = json.loads(detail).get("error", detail)
                except (ValueError, AttributeError):
                    pass
                if error.code == 429 and attempt == 0:
                    time.sleep(0.5)
                    continue
                raise ResponseError(error.code, str(detail)) from None
            except (URLError, OSError, UnicodeError) as error:
                raise ClientError(f"端口读取失败（请确认 Duetlens 运行及链接有效）: {error}") from None

    def context(self):
        try:
            result = json.loads(self.get(self.url))
        except ValueError as error:
            raise ClientError("会话响应不是有效 JSON") from error
        if not isinstance(result, dict) or result.get("kind") != "duetlens.shared-review" or result.get("schemaVersion") != 1:
            raise ClientError("不支持的会话协议；请核验应用当前接口，不能猜测字段")
        return result

    def bind_repository(self, repo_path, context=None):
        """显式写操作:不重试 POST,409 必须重新核对上下文后再次确认。"""
        if not isinstance(repo_path, str) or not Path(repo_path).is_absolute() or "\0" in repo_path:
            raise ClientError("repo-path 必须为本机绝对目录")
        context = self.context() if context is None else context
        if not context.get("access", {}).get("bindRepository"):
            raise ClientError("此运行实例未开放仓库绑定 HTTP 接口，请先更新应用")
        review, repository = context["review"], context["repository"]
        body = {"repoPath": repo_path, "expected": {
            "reviewId": review["id"], "head": review["head"], "round": review["round"],
            "base": review["baseRef"], "repositoryPath": repository["path"], "updatedAt": review["updatedAt"],
        }}
        request = Request(self.url + "/repository", data=json.dumps(body).encode(),
                          headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "duetlens-skill/1"}, method="POST")
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                data = response.read(MAX_RESPONSE + 1)
                if len(data) > MAX_RESPONSE:
                    raise ClientError("绑定响应过大，请重新读取上下文核对结果")
                result = json.loads(data)
                if result.get("kind") != "duetlens.shared-review" or result.get("review", {}).get("id") != review["id"]:
                    raise ClientError("绑定响应会话不匹配，请停止并核对")
                return result
        except HTTPError as error:
            detail = error.read(4096).decode("utf-8", errors="replace")
            try:
                detail = json.loads(detail).get("error", detail)
            except (ValueError, AttributeError):
                pass
            raise ResponseError(error.code, str(detail)) from None
        except (URLError, OSError, UnicodeError, ValueError) as error:
            raise ClientError(f"绑定结果不确定，请先 GET 核对，不要自动重发: {error}") from None

    def versioned(self, command, file_path=None):
        for attempt in range(3):
            context = self.context()
            if command == "diff":
                url = context.get("diffUrl")
            else:
                entry = next((entry for entry in context.get("files", []) if entry.get("path") == file_path), None)
                if entry is None:
                    raise ClientError("文件不在当前分享范围；删除侧请读取 diff，不猜测文件接口")
                url = entry.get("url")
            if not isinstance(url, str):
                raise ClientError("会话未返回有效版本链接")
            try:
                content = self.get(url)
                return content if command == "diff" else json.loads(content)
            except ResponseError as error:
                if error.status == 409 and attempt < 2:
                    continue
                raise
            except ValueError as error:
                raise ClientError("文件响应不是有效 JSON") from error
        raise ClientError("版本持续变化，请稍后重新读取")


def message_kind(message):
    if message.get("role") == "agent":
        return "chat"
    kind = message.get("kind")
    return kind if kind in ("note", "chat") else "legacy"


def comments(context):
    findings = context.get("findings", [])
    by_id = {finding["id"]: finding for finding in findings}
    messages = [message for discussion in context.get("discussions", [])
                for message in discussion.get("messages", [])]
    user_messages = [message for message in messages if message.get("role") == "user"]
    return {
        "repository": context.get("repository"), "review": context.get("review"),
        "findings": findings,
        "discussions": [{**discussion, "finding": by_id.get(discussion.get("findingId"))}
                        for discussion in context.get("discussions", [])],
        "noteMessageIds": [message["id"] for message in user_messages if message_kind(message) == "note"],
        "chatMessageIds": [message["id"] for message in messages if message_kind(message) == "chat"],
        "legacyUserMessageIds": [message["id"] for message in user_messages if message_kind(message) == "legacy"],
        "userMessageKinds": {message["id"]: message_kind(message) for message in user_messages},
        "userMessageIds": [message["id"] for message in user_messages],
        "userMessageDigests": {message["id"]: hashlib.sha256(message.get("text", "").encode()).hexdigest()
                               for discussion in context.get("discussions", []) for message in discussion.get("messages", [])
                               if message.get("role") == "user"},
        "access": context.get("access"),
    }


def discover(directory):
    try:
        port = json.loads((directory / "share-server.json").read_text())["port"]
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("invalid port")
    except (OSError, ValueError, KeyError, TypeError):
        raise ClientError("无法读取分享端口配置；需要应用运行并提供有效分享链接") from None
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            listening = True
    except OSError:
        listening = False
    return {"origin": f"http://127.0.0.1:{port}", "tcpListening": listening,
            "sessionUrlRequired": True,
            "notice": "TCP 监听不代表协议验证；当前 HTTP 没有会话列表接口，需要已有分享链接。"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("discover", "context", "comments", "file", "diff", "bind-repository"))
    parser.add_argument("url", nargs="?")
    parser.add_argument("--path", dest="file_path")
    parser.add_argument("--repo-path")
    parser.add_argument("--confirm", action="store_true", help="确认已获用户授权修改此审核的仓库绑定")
    parser.add_argument("--timeout", type=float, default=45)
    parser.add_argument("--data-dir", type=Path, default=Path.home() / "Library/Application Support/Duetlens")
    args = parser.parse_args()
    if args.command != "discover" and not args.url:
        parser.error("此命令需要分享链接")
    if args.command == "file" and not args.file_path:
        parser.error("file 需要 --path 仓库相对路径")
    if args.command == "bind-repository" and (not args.repo_path or not args.confirm):
        parser.error("bind-repository 需要 --repo-path 绝对目录和 --confirm；不会自动同步或审核")
    if not 0 < args.timeout <= 180:
        parser.error("timeout 必须在 0 到 180 秒之间")
    try:
        if args.command == "discover":
            result = discover(args.data_dir)
        else:
            client = Client(args.url, args.timeout)
            if args.command == "context":
                result = client.context()
            elif args.command == "bind-repository":
                result = client.bind_repository(args.repo_path)
            elif args.command == "comments":
                result = comments(client.context())
            else:
                result = client.versioned(args.command, args.file_path)
        if isinstance(result, str):
            sys.stdout.write(result)
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
    except ClientError as error:
        print(f"Duetlens: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
