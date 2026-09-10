// Sign-in. Posts JSON rather than a form body so the API has one shape.
const form = document.getElementById("login-form");
const input = document.getElementById("password");
const submit = document.getElementById("login-submit");
const error = document.getElementById("login-error");

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    submit.textContent = "Signing in…";

    try {
        // Trailing slash on purpose: vercel.json sets trailingSlash, so the
        // bare path would 308 and cost an extra round trip.
        const res = await fetch("/api/auth/login/", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: input.value }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok) {
            window.location.href = "/editor/";
            return;
        }
        if (res.status === 429) {
            const mins = Math.ceil((Number(res.headers.get("retry-after")) || 900) / 60);
            error.textContent = `Too many attempts. Try again in about ${mins} minute(s).`;
        } else {
            error.textContent = data.message || "Sign-in failed.";
        }
    } catch {
        error.textContent = "Could not reach the server.";
    } finally {
        submit.disabled = false;
        submit.textContent = "Sign in";
        input.select();
    }
});
