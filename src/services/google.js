// Trao doi ma OAuth cua Google lay thong tin nguoi dung.
// Tach rieng de test khong phai goi mang that.
export async function exchangeGoogleCode(code) {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const redirectUri = `${process.env.OAUTH_REDIRECT_BASE || ""}/api/auth/google/callback`;

  let tokenRes;
  try {
    tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
  } catch {
    throw new Error("Không đăng nhập được Google");
  }
  if (!tokenRes.ok) throw new Error("Không đăng nhập được Google");

  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenData.access_token) throw new Error("Không đăng nhập được Google");

  let infoRes;
  try {
    infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
  } catch {
    throw new Error("Không đăng nhập được Google");
  }
  if (!infoRes.ok) throw new Error("Không đăng nhập được Google");

  const info = await infoRes.json().catch(() => ({}));
  if (!info.sub) throw new Error("Không đăng nhập được Google");

  return {
    providerId: String(info.sub),
    email: typeof info.email === "string" ? info.email : "",
    name: typeof info.name === "string" ? info.name : "",
    avatar: typeof info.picture === "string" ? info.picture : "",
  };
}
