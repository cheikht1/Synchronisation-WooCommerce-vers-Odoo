// ============================================================
// 🔗 SYNC WOOCOMMERCE → ODOO ONLINE (Edge Function)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// -----------------------
// 1. CONFIGURATION
// -----------------------

const WC_URL = Deno.env.get("WOO_URL") || "https://moda-sn.com";
const WC_CK = Deno.env.get("WOO_CK") || "";
const WC_CS = Deno.env.get("WOO_CS") || "";

const ODOO_URL = Deno.env.get("ODOO_URL") || "https://mce-senegal.odoo.com";
const ODOO_DB = Deno.env.get("ODOO_DB") || "mce-senegal";
const ODOO_USER = Deno.env.get("ODOO_EMAIL") || "";
const ODOO_PASS = Deno.env.get("ODOO_PASSWORD") || "";

// -----------------------
// 2. HELPER FUNCTIONS
// -----------------------

function log(message: string) {
    const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
    console.log(`[${timestamp}] ${message}`);
}

// Basic Auth for WooCommerce
function getWooAuth() {
    return "Basic " + btoa(`${WC_CK}:${WC_CS}`);
}

// -----------------------
// 3. ODOO CLIENT
// -----------------------

class OdooClient {
    baseUrl: string;
    db: string;
    user: string;
    pass: string;
    sessionId: string | null = null;

    constructor(url: string, db: string, user: string, pass: string) {
        this.baseUrl = url;
        this.db = db;
        this.user = user;
        this.pass = pass;
    }

    async authenticate() {
        log("⏳ Logging into Odoo...");
        const url = `${this.baseUrl}/web/session/authenticate`;
        const payload = {
            jsonrpc: "2.0",
            params: {
                db: this.db,
                login: this.user,
                password: this.pass,
            },
        };

        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);

            const data = await res.json();
            if (data.error) throw new Error(data.error.data.message);
            if (!data.result) throw new Error("Authentication failed");

            // Extract session ID from Set-Cookie header if possible,
            // or rely on the response result if it contains session_id.
            // Deno fetch handling of cookies is manual.
            // Usually Odoo returns session_id in `result.session_id`.
            this.sessionId = data.result.session_id;

            // Also try to get it from headers just in case
            // Note: 'get' on headers is case insensitive
            const setCookie = res.headers.get("set-cookie");
            if (setCookie) {
                // simple parse for session_id
                const match = setCookie.match(/session_id=([^;]+)/);
                if (match) this.sessionId = match[1];
            }

            log("✅ Odoo Connection Successful");
            return true;
        } catch (e) {
            log(`❌ API Connection Error: ${e}`);
            return false;
        }
    }

    async call(model: string, method: string, args: any[], kwargs: any = {}) {
        if (!this.sessionId) throw new Error("Not authenticated");

        const url = `${this.baseUrl}/web/dataset/call_kw`;
        const payload = {
            jsonrpc: "2.0",
            method: "call",
            params: {
                model,
                method,
                args,
                kwargs,
            },
        };

        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Cookie": `session_id=${this.sessionId}`,
            },
            body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (data.error) {
            const errorMsg = data.error.data?.message || JSON.stringify(data.error);
            log(`⚠️ Odoo Error on ${model}: ${errorMsg}`);
            return null;
        }
        return data.result;
    }

    async search(model: string, domain: any[], fields = ["id"]) {
        // search_read
        return await this.call(model, "search_read", [domain], { fields, limit: 1 }) || [];
    }

    async create(model: string, values: any) {
        return await this.call(model, "create", [values]);
    }
}

// -----------------------
// 4. BUSINESS LOGIC
// -----------------------

async function getOrCreateCustomer(odoo: OdooClient, order: any) {
    const billing = order.billing || {};
    const email = (billing.email || "").trim() || `no-email-${order.id}@example.com`;

    const existing = await odoo.search("res.partner", [["email", "=", email]]);
    if (existing && existing.length > 0) {
        return existing[0].id;
    }

    const firstName = billing.first_name || "";
    const lastName = billing.last_name || "";
    const fullName = `${firstName} ${lastName}`.trim() || `Woo Client #${order.id}`;

    const values = {
        name: fullName,
        email: email,
        phone: billing.phone || "",
        street: billing.address_1 || "",
        city: billing.city || "",
        country_id: 195, // Hardcoded Senegal ID from script
        customer_rank: 1,
    };

    return await odoo.create("res.partner", values);
}

async function getOrCreateProduct(odoo: OdooClient, item: any) {
    const sku = item.sku || item.name;
    const existing = await odoo.search("product.product", [["default_code", "=", sku]]);
    if (existing && existing.length > 0) {
        return existing[0].id;
    }

    const values = {
        name: item.name,
        list_price: parseFloat(item.price || "0"),
        default_code: sku,
        type: "consu",
        sale_ok: true,
    };
    return await odoo.create("product.product", values);
}

async function syncOrder(odoo: OdooClient, order: any) {
    const wcId = order.id;
    const originTag = `WC-${wcId}`;

    const existing = await odoo.search("sale.order", [["origin", "=", originTag]]);
    if (existing && existing.length > 0) {
        log(`⏩ Order ${originTag} already imported.`);
        return;
    }

    log(`🔄 Processing Order ${originTag}...`);
    const partnerId = await getOrCreateCustomer(odoo, order);
    if (!partnerId) {
        log("❌ Failed to create customer, skipping order.");
        return;
    }

    const orderLines = [];
    for (const item of order.line_items) {
        const productId = await getOrCreateProduct(odoo, item);
        if (productId) {
            const lineData = {
                product_id: productId,
                name: item.name,
                product_uom_qty: parseFloat(item.quantity),
                price_unit: parseFloat(item.price),
            };
            orderLines.push([0, 0, lineData]);
        }
    }

    if (orderLines.length === 0) {
        log("⚠️ No valid product lines, skipping order.");
        return;
    }

    const orderValues = {
        partner_id: partnerId,
        origin: originTag,
        client_order_ref: String(wcId),
        state: "draft",
        order_line: orderLines,
    };

    const newOrderId = await odoo.create("sale.order", orderValues);
    if (newOrderId) {
        log(`✅ SUCCESS: Order ${originTag} created (Odoo ID: ${newOrderId})`);
    } else {
        log(`❌ FINAL FAILURE creating order ${originTag}`);
    }
}

// -----------------------
// 5. MAIN HANDLER
// -----------------------

serve(async (_req) => {
    log("🚀 Starting Sync Job...");

    // Initialize Odoo
    const odoo = new OdooClient(ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASS);
    const connected = await odoo.authenticate();
    if (!connected) {
        return new Response("Odoo Connection Failed", { status: 500 });
    }

    try {
        log("📡 Fetching WooCommerce orders...");
        // Using WP REST API - default defaults include per_page=10, we want 20
        const res = await fetch(`${WC_URL}/wp-json/wc/v3/orders?per_page=20`, {
            headers: {
                "Authorization": getWooAuth(),
            },
        });

        if (!res.ok) {
            const txt = await res.text();
            log(`❌ WooCommerce Error: ${txt}`);
            return new Response(`WooCommerce Error: ${txt}`, { status: 500 });
        }

        const orders = await res.json();
        log(`🔎 Found ${orders.length} orders.`);

        for (const order of orders) {
            try {
                await syncOrder(odoo, order);
            } catch (e) {
                log(`❌ Unexpected crash on order ${order.id}: ${e}`);
            }
        }

        log("🏁 Sync finished.");
        return new Response("Sync Finished Successfully", { status: 200 });

    } catch (e) {
        log(`❌ Error fetching orders: ${e}`);
        return new Response(`Error: ${e}`, { status: 500 });
    }
});
