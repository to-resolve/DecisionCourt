package middleware

// v2.5 (P1-2) CSRF middleware 双 cookie 模式测试。

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// findCookie 从响应里取指定名字的 Set-Cookie。
func findCookie(t *testing.T, w *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, ck := range w.Result().Cookies() {
		if ck.Name == name {
			return ck
		}
	}
	t.Fatalf("响应里没有 Set-Cookie %s", name)
	return nil
}

func newTestServer(cfg CSRFConfig) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	g := r.Group("/api/v1")
	g.Use(CSRF(cfg))
	// 模拟 auth 中间件：注入 viewer_id 到 ctx
	g.Use(func(c *gin.Context) {
		c.Set("viewer_id", "user-123")
		c.Next()
	})
	g.GET("/protected", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	g.POST("/protected", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	g.POST("/auth/anon", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	return r
}

func performReq(r *gin.Engine, method, path, cookieValue, headerValue string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if cookieValue != "" {
		req.AddCookie(&http.Cookie{Name: "XSRF-TOKEN", Value: cookieValue})
	}
	if headerValue != "" {
		req.Header.Set("X-XSRF-TOKEN", headerValue)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// makeToken 手工构造 CSRF token（用于测试伪造场景）。
func makeToken(secret []byte, userID string, ts int64, nonce string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(fmt.Sprintf("%s|%d|%s", userID, ts, nonce)))
	sig := hex.EncodeToString(mac.Sum(nil))
	raw := fmt.Sprintf("%s.%d.%s.%s", userID, ts, nonce, sig)
	return base64.StdEncoding.EncodeToString([]byte(raw))
}

func newNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// TestCSRF_GetIssuesCookie GET 自动 Set-Cookie XSRF-TOKEN。
func TestCSRF_GetIssuesCookie(t *testing.T) {
	t.Parallel()
	r := newTestServer(DefaultCSRFConfig([]byte("test-secret-32-chars-xxxxxxxxx")))
	w := performReq(r, "GET", "/api/v1/protected", "", "")

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var found *http.Cookie
	for _, ck := range w.Result().Cookies() {
		if ck.Name == "XSRF-TOKEN" {
			found = ck
			break
		}
	}
	if found == nil {
		t.Fatal("expected Set-Cookie XSRF-TOKEN on GET")
	}
	if found.Value == "" {
		t.Error("XSRF-TOKEN cookie value should not be empty")
	}
	if found.HttpOnly {
		t.Error("XSRF-TOKEN 必须非 HttpOnly（前端 JS 读得到）")
	}
}

// TestCSRF_PostRequiresHeader POST 必须带 X-XSRF-TOKEN header。
func TestCSRF_PostRequiresHeader(t *testing.T) {
	t.Parallel()
	r := newTestServer(DefaultCSRFConfig([]byte("test-secret-32-chars-xxxxxxxxx")))

	w := performReq(r, "POST", "/api/v1/protected", "", "")
	if w.Code != 403 {
		t.Errorf("no cookie+header: expected 403, got %d", w.Code)
	}
	w = performReq(r, "POST", "/api/v1/protected", "abc", "")
	if w.Code != 403 {
		t.Errorf("no header: expected 403, got %d", w.Code)
	}
}

// TestCSRF_PostSucceedsWithMatchingTokens cookie == header 通过。
func TestCSRF_PostSucceedsWithMatchingTokens(t *testing.T) {
	t.Parallel()
	secret := []byte("test-secret-32-chars-xxxxxxxxx")
	r := newTestServer(DefaultCSRFConfig(secret))

	tok := makeToken(secret, "user-123", time.Now().Unix(), newNonce())
	w := performReq(r, "POST", "/api/v1/protected", tok, tok)
	if w.Code != 200 {
		t.Errorf("matching tokens: expected 200, got %d (body=%s)", w.Code, w.Body.String())
	}
}

// TestCSRF_PostRejectsMismatchedTokens cookie 与 header 不一致 → 403。
func TestCSRF_PostRejectsMismatchedTokens(t *testing.T) {
	t.Parallel()
	secret := []byte("test-secret-32-chars-xxxxxxxxx")
	r := newTestServer(DefaultCSRFConfig(secret))

	tok := makeToken(secret, "user-123", time.Now().Unix(), newNonce())
	w := performReq(r, "POST", "/api/v1/protected", tok, "different-value")
	if w.Code != 403 {
		t.Errorf("mismatched tokens: expected 403, got %d", w.Code)
	}
}

// TestCSRF_PostRejectsForgedSignature 篡改 sig → 403。
func TestCSRF_PostRejectsForgedSignature(t *testing.T) {
	t.Parallel()
	secret := []byte("test-secret-32-chars-xxxxxxxxx")
	otherSecret := []byte("different-secret-32-chars-yyyyy")
	r := newTestServer(DefaultCSRFConfig(secret))

	tok := makeToken(otherSecret, "user-123", time.Now().Unix(), newNonce())
	w := performReq(r, "POST", "/api/v1/protected", tok, tok)
	if w.Code != 403 {
		t.Errorf("forged sig: expected 403, got %d (body=%s)", w.Code, w.Body.String())
	}
}

// TestCSRF_PostRejectsExpiredToken timestamp 超 ±2h 滑动窗口 → 403。
func TestCSRF_PostRejectsExpiredToken(t *testing.T) {
	t.Parallel()
	secret := []byte("test-secret-32-chars-xxxxxxxxx")
	r := newTestServer(DefaultCSRFConfig(secret))

	oldTs := time.Now().Unix() - 3*3600 // 3 小时前
	tok := makeToken(secret, "user-123", oldTs, newNonce())
	w := performReq(r, "POST", "/api/v1/protected", tok, tok)
	if w.Code != 403 {
		t.Errorf("expired token: expected 403, got %d (body=%s)", w.Code, w.Body.String())
	}
}

// TestCSRF_SkipPathExempt /auth/anon 即使 POST 也不校验 CSRF。
func TestCSRF_SkipPathExempt(t *testing.T) {
	t.Parallel()
	r := newTestServer(DefaultCSRFConfig([]byte("test-secret-32-chars-xxxxxxxxx")))

	w := performReq(r, "POST", "/api/v1/auth/anon", "", "")
	if w.Code != 200 {
		t.Errorf("/auth/anon should skip CSRF, got %d", w.Code)
	}
}

// TestCSRF_PanicOnNilSecret 配置 nil secret 应该 panic。
func TestCSRF_PanicOnNilSecret(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic on nil secret")
		}
	}()
	gin.SetMode(gin.TestMode)
	CSRF(CSRFConfig{Secret: nil})
}

// TestCSRF_RejectsMalformedTokenBase64 token 不是合法 base64 → 403。
func TestCSRF_RejectsMalformedTokenBase64(t *testing.T) {
	t.Parallel()
	r := newTestServer(DefaultCSRFConfig([]byte("test-secret-32-chars-xxxxxxxxx")))

	w := performReq(r, "POST", "/api/v1/protected", "not-base64-!!!", "not-base64-!!!")
	if w.Code != 403 {
		t.Errorf("malformed token: expected 403, got %d", w.Code)
	}
}

// TestCSRF_RejectsWrongPartCount base64 OK 但字段数 != 4 → 403。
func TestCSRF_RejectsWrongPartCount(t *testing.T) {
	t.Parallel()
	r := newTestServer(DefaultCSRFConfig([]byte("test-secret-32-chars-xxxxxxxxx")))

	bad := base64.StdEncoding.EncodeToString([]byte("only.two")) // 只有 2 段
	w := performReq(r, "POST", "/api/v1/protected", bad, bad)
	if w.Code != 403 {
		t.Errorf("wrong part count: expected 403, got %d", w.Code)
	}
}

// TestCSRF_IssuedCookiePathIsRoot XSRF-TOKEN 的 Path 必须是 "/"。
//
// 回归护栏（2026-09-21，线上事故）。
//
// 历史实现把 CookiePath 设为 "/api/v1"，注释理由是"让 JS 在 API 请求域下读得到"。
// 该推理错误：RFC 6265 §5.4 规定 document.cookie 只暴露 path 能匹配**当前文档 URL**
// 的 cookie（而 Set-Cookie 的 path 匹配的是**请求 URL**）。前端页面在 /、/court/*、
// /verdict/*，永远匹配不上 /api/v1，于是：
//
//	document.cookie  →  ""（前端 readCookie() 拿不到值，不带 X-XSRF-TOKEN 头）
//	POST /api/v1/... → 自动带 cookie 但 header 为空 → 403 CSRF_TOKEN_MISMATCH
//
// 症状就是"点立案开庭必报 403 Forbidden"（本地与线上一致）。
//
// 为什么原有 10 个测试全绿也没发现：httptest 不模拟 document.cookie 的可见性语义，
// 它只看中间件逻辑。**唯一能在单测层抓住它的办法就是断言 Path 本身**。
func TestCSRF_IssuedCookiePathIsRoot(t *testing.T) {
	t.Parallel()
	r := newTestServer(DefaultCSRFConfig([]byte("test-secret-32-chars-xxxxxxxxx")))
	w := performReq(r, "GET", "/api/v1/protected", "", "")

	ck := findCookie(t, w, "XSRF-TOKEN")
	if ck.Path != "/" {
		t.Fatalf("XSRF-TOKEN 的 Path 必须是 \"/\"，实际 %q。\n"+
			"前端页面在 / 或 /court/*，document.cookie 读不到非根路径的 cookie，"+
			"会导致所有 POST 缺 X-XSRF-TOKEN 头而 403。", ck.Path)
	}
}

// TestCSRF_BrowserRoundTrip 模拟"真实浏览器 + 前端 fetch wrapper"的完整往返。
//
// 与 TestCSRF_PostSucceedsWithMatchingTokens 的关键区别：
// 后者把**同一个原始字符串**同时当 cookie 和 header 用；真实链路里两端并不相同——
//
//	后端 gin.SetCookie → url.QueryEscape(token)  ← 浏览器存储的就是这个转义值
//	前端 readCookie()  → decodeURIComponent(...) ← 解码后放 header
//	后端 c.Cookie()    → url.QueryUnescape(...)  ← 解得回原始 token，与 header 相等
//
// 任何一环转义规则对不上就会 403。前端 decodeURIComponent 的 Go 等价物是
// url.PathUnescape（两者都不把 "+" 当空格，这点与 url.QueryUnescape 不同）。
func TestCSRF_BrowserRoundTrip(t *testing.T) {
	t.Parallel()
	secret := []byte("test-secret-32-chars-xxxxxxxxx")
	r := newTestServer(DefaultCSRFConfig(secret))

	// 跑多轮：token 含随机 nonce，只有部分值会真的出现需要转义的字符。
	// 多轮既覆盖"需转义"也覆盖"不需转义"两种情况。
	sawEscaping := false
	for i := 0; i < 30; i++ {
		w := performReq(r, "GET", "/api/v1/protected", "", "")
		ck := findCookie(t, w, "XSRF-TOKEN")

		if strings.Contains(ck.Value, "%") {
			sawEscaping = true
		}
		// 不变量：存储值里不应出现裸 "+"。gin 的 QueryEscape 会把它编成 %2B；
		// 若出现裸 "+"，说明 setCSRFCookie 不再走 gin 的转义，
		// 前端的 decodeURIComponent 与后端的 QueryUnescape 会在此处分叉。
		if strings.Contains(ck.Value, "+") {
			t.Errorf("第 %d 轮 cookie 值含裸 '+'（%q）：前后端解码规则会分叉", i, ck.Value)
		}

		headerVal, err := url.PathUnescape(ck.Value) // == 前端 decodeURIComponent
		if err != nil {
			t.Fatalf("第 %d 轮 PathUnescape 失败: %v", i, err)
		}

		w2 := performReq(r, "POST", "/api/v1/protected", ck.Value, headerVal)
		if w2.Code != 200 {
			t.Fatalf("第 %d 轮浏览器往返期望 200，实际 %d (cookie=%q header=%q)",
				i, w2.Code, ck.Value, headerVal)
		}
	}

	if !sawEscaping {
		t.Fatal("30 轮都没出现含 % 的 cookie 值，说明转义路径未被覆盖——" +
			"检查 setCSRFCookie 是否仍在用 gin 的 c.SetCookie（它负责 QueryEscape）")
	}
}
