/**
 * FarmConnectZW — Navbar renderer
 * Call renderNavbar(role) after auth resolves.
 */
function renderNavbar(role) {
  const farmerLinks = `
    <a href="dashboard-farmer.html">Dashboard</a>
    <a href="livestock-tracking.html">Livestock</a>
    <a href="map.html">Map</a>
    <a href="market-prices.html">Market</a>
    <a href="knowledge-hub.html">Learn</a>
    <a href="messages.html">Messages</a>
    <a href="notifications.html">Alerts</a>
    <a href="profile.html">Profile</a>`;

  const officerLinks = `
    <a href="dashboard-officer.html">Dashboard</a>
    <a href="map.html">Map</a>
    <a href="market-prices.html">Market</a>
    <a href="knowledge-hub.html">Learn</a>
    <a href="messages.html">Messages</a>
    <a href="notifications.html">Alerts</a>
    <a href="profile.html">Profile</a>`;

  const adminLinks = `
    <a href="dashboard-admin.html">Dashboard</a>
    <a href="map.html">Map</a>
    <a href="market-prices.html">Market</a>
    <a href="knowledge-hub.html">Learn</a>
    <a href="messages.html">Messages</a>
    <a href="notifications.html">Alerts</a>
    <a href="profile.html">Profile</a>`;

  const links = role === 'administrator' ? adminLinks : role === 'extension_officer' ? officerLinks : farmerLinks;
  const label = { farmer:'Farmer', extension_officer:'Officer', administrator:'Admin' }[role] || '';

  const el = document.getElementById('navbar');
  if (!el) return;
  el.innerHTML = `
    <div class="navbar-container">
      <a href="${FCZ.dashboardFor(role)}" class="navbar-brand">
        🌾 <span class="hidden-mobile">FarmConnectZW</span>
        <span class="navbar-role-badge">${label}</span>
      </a>
      <button class="navbar-toggle" aria-label="Menu">☰</button>
      <ul class="navbar-nav">
        <li style="display:flex;gap:4px;flex-wrap:wrap">${links}</li>
        <li><button class="nav-link" data-action="logout">Logout</button></li>
      </ul>
    </div>`;
  FCZ.initNavbar();
}
window.renderNavbar = renderNavbar;
