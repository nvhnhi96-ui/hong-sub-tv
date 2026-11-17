import UIKit
import WebKit

/// Sign in to PlayStation Network on Sony's own page, only to read the account id that pairing with the PS5 needs
/// (the same sign-in as PS Remote Play and chiaki-ng). Hóng Sub never sees the password: Sony's page takes it,
/// then sends the browser to .../remoteplay/redirect?code=..., and that code is exchanged for the account id.
final class PsnLogin: UIViewController, WKNavigationDelegate {
    private static let clientId = "ba495a24-818c-472b-b12d-ff231c1b5745"
    private static let clientSecret = "mvaiZkRsAsI1IBkY"
    private static let scope = "psn:clientapp referenceDataService:countryConfig.read pushNotification:webSocket.desktop.connect sessionManager:remotePlaySession.system.update"
    private static let redirect = "https://remoteplay.dl.playstation.net/remoteplay/redirect"
    private static let tokenUrl = "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token"

    private static weak var current: PsnLogin?
    private var done: (([String: Any]) -> Void)?
    private var web: WKWebView!

    static func present(from vc: UIViewController, done: @escaping ([String: Any]) -> Void) {
        current?.finish(["ok": false, "err": "again"])
        let p = PsnLogin()
        p.done = done
        current = p
        let nav = UINavigationController(rootViewController: p)
        nav.modalPresentationStyle = .fullScreen
        vc.present(nav, animated: true)
    }

    static func cancel() { DispatchQueue.main.async { current?.finish(["ok": false, "err": "closed"]) } }

    private func finish(_ r: [String: Any]) {
        guard let d = done else { return }
        done = nil
        dismiss(animated: true)
        d(r)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Đăng nhập PlayStation"
        view.backgroundColor = .black
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Đóng", style: .plain, target: self, action: #selector(closeTap))
        let cfg = WKWebViewConfiguration()
        /* look like Safari on this iPhone: Sony's robot check is stricter with app windows */
        let v = UIDevice.current.systemVersion.split(separator: ".").prefix(2).joined(separator: ".")
        cfg.applicationNameForUserAgent = "Version/\(v) Mobile/15E148 Safari/604.1"
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        if let u = URL(string: Self.loginUrl()) { web.load(URLRequest(url: u)) }
    }

    @objc private func closeTap() { finish(["ok": false, "err": "closed"]) }

    private static func loginUrl() -> String {
        var duid = "0000000700410080"
        for _ in 0..<16 { duid += String(format: "%02x", UInt8.random(in: 0...255)) }
        let sc = scope.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize?service_entity=urn:service-entity:psn&response_type=code&client_id=\(clientId)"
            + "&redirect_uri=\(redirect)&scope=\(sc)&request_locale=en_US&ui=pr&service_logo=ps&layout_type=popup&smcid=remoteplay&prompt=always&PlatformPrivacyWs1=minimal&duid=\(duid)&"
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = action.request.url, u.absoluteString.hasPrefix(Self.redirect) else { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        let code = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value ?? ""
        if code.isEmpty { finish(["ok": false, "err": u.absoluteString.contains("error") ? "denied" : "code"]); return }
        Self.exchange(code) { [weak self] r in DispatchQueue.main.async { self?.finish(r) } }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        /* Sony's "Can't connect to the server": its robot check refused, say so instead of leaving it there */
        webView.evaluateJavaScript("document.body?document.body.innerText.slice(0,3000):''") { [weak self] res, _ in
            guard let t = res as? String else { return }
            if t.range(of: "can.t connect to the server|không thể kết nối với máy chủ", options: [.regularExpression, .caseInsensitive]) != nil {
                self?.finish(["ok": false, "err": "blocked"])
            }
        }
    }

    private static func request(_ url: String, body: String?, then: @escaping ([String: Any]?, String?) -> Void) {
        guard let u = URL(string: url) else { then(nil, "url"); return }
        var r = URLRequest(url: u, timeoutInterval: 15)
        r.httpMethod = body == nil ? "GET" : "POST"
        let basic = Data("\(clientId):\(clientSecret)".utf8).base64EncodedString()
        r.setValue("Basic \(basic)", forHTTPHeaderField: "Authorization")
        if let b = body {
            r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            r.httpBody = Data(b.utf8)
        }
        URLSession.shared.dataTask(with: r) { data, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let j = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            if let e = err { then(nil, e.localizedDescription); return }
            if code >= 400 { then(nil, (j?["error_description"] as? String) ?? (j?["error"] as? String) ?? "HTTP \(code)"); return }
            then(j, nil)
        }.resume()
    }

    private static func form(_ s: String) -> String {
        var a = CharacterSet.alphanumerics; a.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: a) ?? s
    }

    /// the code from Sony's page -> the account id (8 bytes, little endian, base64) that pairing needs
    private static func exchange(_ code: String, done: @escaping ([String: Any]) -> Void) {
        let body = "grant_type=authorization_code&code=\(form(code))&scope=\(form(scope))&redirect_uri=\(form(redirect))&"
        request(tokenUrl, body: body) { tok, err in
            guard let at = tok?["access_token"] as? String, !at.isEmpty else { done(["ok": false, "err": err ?? "token"]); return }
            request(tokenUrl + "/" + at, body: nil) { me, err2 in
                let uidAny = me?["user_id"]
                let uidStr = (uidAny as? String) ?? (uidAny as? NSNumber)?.stringValue ?? ""
                guard let uid = UInt64(uidStr) else { done(["ok": false, "err": err2 ?? "account"]); return }
                var le = uid.littleEndian
                let acc = withUnsafeBytes(of: &le) { Data($0) }.base64EncodedString()
                done(["ok": true, "account": acc, "onlineId": (me?["online_id"] as? String) ?? ""])
            }
        }
    }
}
