
const docContent = {
    terms: `
        <h1>Terms and Conditions of Service</h1>
        <p class="last-updated">Last Revised: April 29, 2026</p>
        
        <h2> BINDING AGREEMENT AND JURISDICTIONAL ACCEPTANCE</h2>
        <p>This document constitutes a legally binding agreement between the end-user (hereinafter referred to as "The User", "You", or "Participant") and the administrative collective of FarmConnectZW, operating under the ModernizeFlow digital framework. By engaging with the domain farmconnectzw.co.zw, interacting with the Firebase-backed data structures, or utilizing the messaging protocols provided, you hereby signify an irrevocable acceptance of these comprehensive Terms and Conditions.</p>
        <p>If you represent a corporate entity or an agricultural collective, you warrant that you possess the legal authority to bind said entity to these protocols. Failure to comply with any provision herein may result in the immediate termination of access and potential legal remediation under the statutes of the Republic of Zimbabwe.</p>

        <h2> SCOPE OF THE DIGITAL ECOSYSTEM</h2>
        <p>FarmConnectZW operates as a decentralized facilitation layer for the agricultural sector. The platform provides a medium for:
        <ul>
            <li>Real-time synchronization of agricultural commodity listings;</li>
            <li>Direct peer-to-peer communication via encrypted-in-transit messaging;</li>
            <li>Verification indexing for extension officers and high-volume suppliers;</li>
            <li>Logistics coordination with third-party delivery providers.</li>
        </ul>
        You acknowledge that the Platform does not hold title to any goods listed and acts exclusively as an information intermediary.</p>

        <h2> USER REGISTRATION AND CREDENTIAL INTEGRITY</h2>
        <p>Access to certain modules requires the creation of a unique User Identifier (UID). You agree to provide metadata that is accurate, current, and verifiable. The platform utilizes Firebase Authentication; however, the User remains solely responsible for the physical and digital security of their access tokens and passwords.</p>
        <p>The creation of "bot" accounts, automated scraping profiles, or duplicate identities for the purpose of manipulating marketplace visibility is strictly prohibited and constitutes a material breach of this agreement.</p>

        <h2> MARKETPLACE LIABILITY AND INDEMNIFICATION</h2>
        <p>The FarmConnectZW Marketplace is provided on an "AS IS" and "AS AVAILABLE" basis. We expressly disclaim all warranties of any kind, whether express or implied.
        <ul>
            <li><strong>No Inspection:</strong> We do not verify the phytosanitary condition of produce, the chemical composition of fertilizers, or the mechanical integrity of equipment listed.</li>
            <li><strong>Transactional Risk:</strong> All financial exchanges occur outside the Platform's primary code execution environment. FarmConnectZW is not liable for payment defaults, chargebacks, or fraudulent mobile money transfers.</li>
            <li><strong>Third-Party Logistics:</strong> Delivery companies listed are independent contractors. We are not responsible for spoilage, theft, or delays occurring during the transit of agricultural goods.</li>
        </ul></p>

        <h2> INTELLECTUAL PROPERTY AND ARCHITECTURAL RIGHTS</h2>
        <p>The architectural logic, including the Vanilla JavaScript modules, CSS layout definitions, and the Firebase security ruleset, are the exclusive property of the developers. You are granted a limited, non-transferable license to access the interface via standard web browsing software. Any attempt to reverse-engineer the "Online Status" logic, the "Verified Badge" distribution system, or the Marketplace filtering algorithms is a violation of copyright law.</p>

        <h2> LIMITATION OF CONSEQUENTIAL DAMAGES</h2>
        <p>In no event shall the developers, ModernizeFlow, or associated extension officers be held liable for any loss of crop yield, loss of business profits, data corruption, or hardware failure resulting from the use of this platform. The maximum aggregate liability of the platform shall not exceed the amount paid by the user to the platform (if any) in the preceding twelve-month period.</p>

        <h2> SEVERABILITY AND GOVERNING STATUTES</h2>
        <p>Should any clause within this exhaustive document be deemed unenforceable by a court of competent jurisdiction in the Midlands Province or elsewhere in Zimbabwe, the remaining clauses shall remain in full force. These terms are governed by the laws of Zimbabwe, and any disputes shall be settled through mandatory arbitration prior to any civil litigation.</p>
    `,
    about: `
        <h1>About FarmConnectZW</h1>
        <p>FarmConnectZW is the definitive digital ecosystem for the Zimbabwean agricultural community. Founded in Kwekwe, our mission is to bridge the technological gap between rural productivity and urban demand.</p>
        <p>By leveraging real-time data synchronization and a custom-built messaging infrastructure, we provide farmers with the tools they need to scale their operations in a modern economy.</p>
    `,
    privacy: `
        <h1>Privacy Policy</h1>
        <p>FarmConnectZW is committed to protecting your privacy. We collect only the necessary data to facilitate marketplace transactions and communication. All personal information is stored securely in Firebase and is not shared with third parties without explicit consent.</p>
        <p>We use industry-standard encryption for data in transit and at rest. Users have the right to access, modify, or delete their personal information by contacting our support team.</p>
    `
};

const loadDoc = () => {
    const params = new URLSearchParams(window.location.search);
    const page = params.get('page') || 'about';
    const container = document.getElementById('legal-content');
    
    if (docContent[page]) {
        container.innerHTML = docContent[page];
        window.scrollTo(0, 0); // Reset scroll to top
    } else {
        container.innerHTML = docContent.about;
    }
};

document.addEventListener('DOMContentLoaded', loadDoc);