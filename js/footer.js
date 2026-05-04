// js/footer.js
const renderFooter = () => {
  const footerHTML = `
  <footer class="main-footer">
    <div class="footer-container">
      <div class="footer-grid">
        <div class="footer-brand">
          <div class="footer-logo">🌾 FarmConnectZW</div>
          <p>The definitive digital ecosystem for Zimbabwean agriculture. Connecting farmers, suppliers, and officers in real-time.</p>
        </div>
        
        <div class="footer-links">
          <h4>Platform</h4>
          <a href="marketplace.html">Marketplace</a>
          <a href="messages.html">Messaging</a>
          <a href="profile.html">My Account</a>
          <a href="dashboard-farmer.html">Dashboard</a>
          <a href="knowledge-hub.html">Knowledge Hub</a>
          <a href="map.html">Farm Map</a>
          <a href="market-prices.html">Market Prices</a>
          
        </div>

        <div class="footer-links">
          <h4>Legal & Info</h4>
          <a href="info.html?page=about">About Us</a>
          <a href="info.html?page=terms">Terms & Conditions</a>
          <a href="info.html?page=privacy">Privacy Policy</a>
        </div>
      </div>
      
      <div class="footer-bottom">
        <p>&copy; ${new Date().getFullYear()} FarmConnectZW. All rights reserved.</p>
      </div>
    </div>
  </footer>
  `;

  document.body.insertAdjacentHTML('beforeend', footerHTML);
};

document.addEventListener('DOMContentLoaded', renderFooter);