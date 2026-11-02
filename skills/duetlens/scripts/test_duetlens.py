"""隔离 HTTP 服务验证客户端,不读取用户评论或修改真实仓库。"""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
from duetlens import Client, ClientError, ResponseError, comments, session_url


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.head = 'a' * 40
        self.stale = 0
        self.file_requests = 0
        self.external = False
        self.redirect = False
        test = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                route = urlsplit(self.path)
                status = 200
                if route.path.endswith('/file'):
                    test.file_requests += 1
                    if test.stale:
                        test.stale -= 1
                        test.head = 'b' * 40
                        status, body = 409, {'error': 'changed'}
                    else:
                        assert parse_qs(route.query)['head'] == [test.head]
                        body = {'path': '空 格.ts', 'head': test.head, 'kind': 'file', 'content': 'const latest = true;'}
                elif route.path.endswith('/diff'):
                    body = '--- a/old.ts\n+++ b/new.ts\n'
                else:
                    body = {'kind': 'duetlens.shared-review', 'schemaVersion': 1,
                            'review': {'head': test.head}, 'repository': {'path': '/test'},
                            'findings': [{'id': 'f', 'body': 'context'}],
                            'discussions': [{'id': 'd', 'file': '空 格.ts', 'side': 'old', 'line': 4, 'findingId': 'f',
                                             'messages': [{'id': 'm', 'role': 'user', 'text': '改这里'}]}],
                            'files': [{'path': '空 格.ts', 'url': test.url + '/file?path=x&head=' + test.head + '&round=1&base='}],
                            'diffUrl': test.url + '/diff?head=' + test.head + '&round=1&base='}
                    if test.external:
                        body['files'][0]['url'] = 'http://example.com/sessions/' + 'x' * 43 + '/file'
                    if test.redirect:
                        self.send_response(302); self.send_header('Location', 'http://example.com/'); self.end_headers(); return
                self.send_response(status); self.end_headers()
                self.wfile.write((body if isinstance(body, str) else json.dumps(body)).encode())
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = 'http://127.0.0.1:%d/sessions/%s' % (self.server.server_port, 'x' * 43)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = Client(self.url)

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def test_comments_and_versioned_file(self):
        result = comments(self.client.context())
        self.assertEqual(result['userMessageIds'], ['m'])
        changed = self.client.context()
        changed['discussions'][0]['messages'][0]['text'] = '同一个批注已编辑'
        self.assertNotEqual(comments(changed)['userMessageDigests']['m'], result['userMessageDigests']['m'])
        self.assertEqual(result['discussions'][0]['side'], 'old')
        self.assertEqual(result['discussions'][0]['finding']['id'], 'f')
        self.assertEqual(self.client.versioned('file', '空 格.ts')['kind'], 'file')
        self.assertTrue(self.client.versioned('diff').startswith('---'))

    def test_note_chat_and_legacy_classification_preserves_thread(self):
        context = self.client.context()
        messages = context['discussions'][0]['messages']
        messages.extend([
            {'id': 'note', 'role': 'user', 'kind': 'note', 'text': '修改要求'},
            {'id': 'question', 'role': 'user', 'kind': 'chat', 'text': '为什么这样写'},
            {'id': 'answer', 'role': 'agent', 'text': '历史回复'},
            {'id': 'legacy', 'role': 'user', 'kind': 'legacy', 'text': '旧留言'},
        ])
        result = comments(context)
        self.assertEqual(result['noteMessageIds'], ['note'])
        self.assertEqual(result['chatMessageIds'], ['question', 'answer'])
        self.assertEqual(result['legacyUserMessageIds'], ['m', 'legacy'])
        self.assertEqual(result['userMessageKinds']['question'], 'chat')
        self.assertEqual(result['discussions'][0]['messages'], messages)
        messages[0]['kind'] = 'note'
        updated = comments(context)
        self.assertNotEqual(updated['userMessageKinds']['m'], result['userMessageKinds']['m'])
        self.assertEqual(updated['userMessageDigests']['m'], result['userMessageDigests']['m'])

    def test_stale_reread_and_bounded_retry(self):
        self.stale = 1
        self.assertEqual(self.client.versioned('file', '空 格.ts')['head'], 'b' * 40)
        self.assertEqual(self.file_requests, 2)
        self.stale = 10; self.file_requests = 0
        with self.assertRaises(ResponseError): self.client.versioned('file', '空 格.ts')
        self.assertEqual(self.file_requests, 3)

    def test_external_links_and_redirects_are_not_followed(self):
        self.external = True
        with self.assertRaises(ClientError): self.client.versioned('file', '空 格.ts')
        self.external = False; self.redirect = True
        with self.assertRaises(ResponseError) as error: self.client.context()
        self.assertEqual(error.exception.status, 302)

    def test_invalid_urls_and_missing_file(self):
        for value in ['https://127.0.0.1:80/sessions/' + 'x' * 43, self.url + '?x=y', self.url.replace('127.0.0.1', 'example.com')]:
            with self.assertRaises(ClientError): session_url(value)
        with self.assertRaises(ClientError): self.client.versioned('file', '../private')
        self.assertEqual(self.file_requests, 0)


if __name__ == '__main__': unittest.main()
