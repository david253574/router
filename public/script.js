document.addEventListener('DOMContentLoaded', () => {
    const loginSection = document.getElementById('login-section');
    const appSection = document.getElementById('app-section');
    
    const loginForm = document.getElementById('login-form');
    const loginMessageEl = document.getElementById('login-message');
    
    const form = document.getElementById('redirect-form');
    const messageEl = document.getElementById('message');
    const tableBody = document.querySelector('#redirects-table tbody');
    const logoutBtn = document.getElementById('logout-btn');

    function checkAuth() {
        fetch('/api/auth/status')
            .then(res => res.json())
            .then(data => {
                if (data.authenticated) {
                    showApp();
                } else {
                    showLogin();
                }
            })
            .catch(() => showLogin());
    }

    function showLogin() {
        loginSection.style.display = 'block';
        appSection.style.display = 'none';
    }

    function showApp() {
        loginSection.style.display = 'none';
        appSection.style.display = 'block';
        loadRedirects();
    }

    function showMessage(msg, isError = false, el = messageEl) {
        el.textContent = msg;
        el.className = 'message ' + (isError ? 'error' : 'success');
        el.style.display = 'block';
        setTimeout(() => { el.style.display = 'none'; }, 5000);
    }

    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;

        fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        })
        .then(async res => {
            if (res.ok) {
                loginForm.reset();
                showApp();
            } else {
                const data = await res.json();
                showMessage(data.error || 'Login failed', true, loginMessageEl);
            }
        })
        .catch(() => showMessage('Error logging in', true, loginMessageEl));
    });

    logoutBtn.addEventListener('click', () => {
        fetch('/api/auth/logout', { method: 'POST' })
            .then(() => {
                showLogin();
            });
    });

    function loadRedirects() {
        fetch('/api/redirects')
            .then(res => {
                if (res.status === 401) {
                    showLogin();
                    throw new Error('Unauthorized');
                }
                return res.json();
            })
            .then(data => {
                tableBody.innerHTML = '';
                data.forEach(redirect => {
                    const tr = document.createElement('tr');
                    
                    const statusText = redirect.active ? 'Active' : 'Disabled';
                    const expText = redirect.expires_at ? new Date(redirect.expires_at).toLocaleString() : 'Never';
                    const createdText = new Date(redirect.created_at).toLocaleDateString();
                    
                    tr.innerHTML = `
                        <td><strong>${redirect.alias}</strong></td>
                        <td><a href="${redirect.destination_url}" target="_blank">${redirect.destination_url}</a></td>
                        <td>${statusText}</td>
                        <td>${expText}</td>
                        <td>${createdText}</td>
                        <td class="actions-cell">
                            <button onclick="copyToClipboard('${redirect.redirect_url}')">Copy Link</button>
                            <button class="${redirect.active ? 'danger' : 'success-btn'}" onclick="toggleStatus(${redirect.id}, ${redirect.active})">
                                ${redirect.active ? 'Disable' : 'Enable'}
                            </button>
                            <button class="danger" onclick="deleteRedirect(${redirect.id})">Delete</button>
                        </td>
                    `;
                    tableBody.appendChild(tr);
                });
            })
            .catch(err => console.error(err));
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const alias = document.getElementById('alias').value;
        const destination_url = document.getElementById('destination_url').value;
        const expires_at = document.getElementById('expires_at').value;

        const body = { alias, destination_url };
        if (expires_at) {
            body.expires_at = new Date(expires_at).toISOString();
        }

        fetch('/api/redirects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
        .then(async res => {
            if (res.status === 401) return showLogin();
            const data = await res.json();
            if (res.ok) {
                showMessage(`Redirect created successfully! URL: ${data.redirect_url}`);
                form.reset();
                loadRedirects();
            } else {
                showMessage(data.error || 'Failed to create redirect.', true);
            }
        })
        .catch(err => showMessage('An error occurred.', true));
    });

    window.copyToClipboard = (text) => {
        navigator.clipboard.writeText(text).then(() => {
            showMessage('Copied to clipboard!');
        }).catch(() => {
            showMessage('Failed to copy to clipboard.', true);
        });
    };

    window.toggleStatus = (id, currentStatus) => {
        fetch(`/api/redirects/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: !currentStatus })
        })
        .then(res => {
            if (res.status === 401) return showLogin();
            if (res.ok) loadRedirects();
            else showMessage('Failed to update status', true);
        });
    };

    window.deleteRedirect = (id) => {
        if (!confirm('Are you sure you want to delete this redirect?')) return;
        fetch(`/api/redirects/${id}`, { method: 'DELETE' })
        .then(res => {
            if (res.status === 401) return showLogin();
            if (res.ok) loadRedirects();
            else showMessage('Failed to delete', true);
        });
    };

    checkAuth();
});
