import UIKit
import WebKit

/// TV Samsung from the iPhone: what the page cannot do itself.
/// - the Samsung account sign-in page in a window of the app (Samsung's page posts the result to
///   http://localhost:4794/signin/callback, where the app's core catches it, hsnet.c)
/// - plain HTTPS requests to Samsung's certificate service (multipart forms), which a web page may not send
final class SamsungLogin: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private static weak var current: SamsungLogin?
    private var done: (([String: Any]) -> Void)?
    private var url: URL?
    private var web: WKWebView!

    static func present(from vc: UIViewController, url: String, done: @escaping ([String: Any]) -> Void) {
        current?.finish(["ok": false, "err": "again"])
        let p = SamsungLogin()
        p.done = done
        p.url = URL(string: url)
        current = p
        let nav = UINavigationController(rootViewController: p)
        nav.modalPresentationStyle = .fullScreen
        vc.present(nav, animated: true)
    }

    static func close() { DispatchQueue.main.async { current?.finish(["ok": true]) } }

    private func finish(_ r: [String: Any]) {
        guard let d = done else { return }
        done = nil
        dismiss(animated: true)
        d(r)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Đăng nhập Samsung"
        view.backgroundColor = .black
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Đóng", style: .plain, target: self, action: #selector(closeTap))
        let cfg = WKWebViewConfiguration()
        let v = UIDevice.current.systemVersion.split(separator: ".").prefix(2).joined(separator: ".")
        cfg.applicationNameForUserAgent = "Version/\(v) Mobile/15E148 Safari/604.1"
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        if let u = url { web.load(URLRequest(url: u)) }
    }

    @objc private func closeTap() { finish(["ok": false, "err": "closed"]) }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        /* Google does not sign in inside an app window: Samsung's own e-mail and password only */
        if let h = action.request.url?.host?.lowercased(), h == "accounts.google.com" {
            decisionHandler(.cancel)
            let a = UIAlertController(title: nil, message: "Đăng nhập bằng Google không dùng được ở đây. Dùng email và mật khẩu tài khoản Samsung (đặt mật khẩu trong tài khoản Samsung nếu chưa có).", preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default))
            present(a, animated: true)
            return
        }
        decisionHandler(.allow)
    }

    /* a link that opens a new window stays in this one */
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil { webView.load(action.request) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        /* Samsung's page sent the sign-in to the app's catcher: done */
        if let u = webView.url, let h = u.host, (h == "localhost" || h == "127.0.0.1"), u.port == 4794 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.finish(["ok": true]) }
        }
    }
}

enum NatHttp {
    /// {url, method, fields:{name:value}, files:[{name, filename, b64, type}], headers:{...}, body(b64)} -> {ok, status, b64}
    static func run(_ a: [String: Any], done: @escaping ([String: Any]) -> Void) {
        guard let us = a["url"] as? String, us.hasPrefix("https://"), let u = URL(string: us) else { done(["ok": false, "err": "url"]); return }
        var r = URLRequest(url: u, timeoutInterval: 40)
        let method = (a["method"] as? String) ?? "GET"
        r.httpMethod = method
        (a["headers"] as? [String: String])?.forEach { r.setValue($0.value, forHTTPHeaderField: $0.key) }
        let fields = a["fields"] as? [String: String]
        let files = a["files"] as? [[String: Any]]
        if method == "POST" && (fields != nil || files != nil) {
            let bnd = "----HongSub\(UInt64.random(in: 0...UInt64.max))"
            var b = Data()
            for (k, v) in fields ?? [:] { b.append(Data("--\(bnd)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n".utf8)) }
            for f in files ?? [] {
                let name = (f["name"] as? String) ?? "file", fn = (f["filename"] as? String) ?? "file", ty = (f["type"] as? String) ?? "application/octet-stream"
                b.append(Data("--\(bnd)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(fn)\"\r\nContent-Type: \(ty)\r\n\r\n".utf8))
                b.append(Data(base64Encoded: (f["b64"] as? String) ?? "", options: .ignoreUnknownCharacters) ?? Data())
                b.append(Data("\r\n".utf8))
            }
            b.append(Data("--\(bnd)--\r\n".utf8))
            r.setValue("multipart/form-data; boundary=\(bnd)", forHTTPHeaderField: "Content-Type")
            r.httpBody = b
        } else if let body = a["body"] as? String {
            r.httpBody = Data(base64Encoded: body, options: .ignoreUnknownCharacters)
        }
        URLSession.shared.dataTask(with: r) { data, resp, err in
            if let e = err { done(["ok": false, "err": e.localizedDescription]); return }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            done(["ok": true, "status": code, "b64": (data ?? Data()).base64EncodedString()])
        }.resume()
    }
}
