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

// Validation helpers
function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizePrice(value: any): number {
    const price = parseFloat(value);
    return isNaN(price) ? 0 : Math.max(0, price);
}

function sanitizeQuantity(value: any): number {
    const qty = parseFloat(value);
    return isNaN(qty) || qty <= 0 ? 1 : qty;
}

// -----------------------
// 3. ODOO CLIENT
// -----------------------

class OdooClient {
    baseUrl: string;
    db: string;
    user: string;
    pass: string;
    uid: number | null = null;
    sessionId: string | null = null;

    constructor(url: string, db: string, user: string, pass: string) {
        this.baseUrl = url;
        this.db = db;
        this.user = user;
        this.pass = pass;
    }

    // Authentification Odoo
    async authenticate() {
        log("🔐 Authenticating with Odoo...");
        const url = `${this.baseUrl}/web/session/authenticate`;

        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    params: {
                        db: this.db,
                        login: this.user,
                        password: this.pass,
                    },
                }),
            });

            const data = await res.json();

            if (data.error) {
                log(`❌ Odoo Auth Error: ${JSON.stringify(data.error)}`);
                throw new Error(`Odoo authentication failed: ${data.error.data?.message || 'Unknown error'}`);
            }

            if (data.result && data.result.uid) {
                this.uid = data.result.uid;

                // Capture session_id from result or cookies (Critical for Odoo)
                if (data.result.session_id) {
                    this.sessionId = data.result.session_id;
                }

                const setCookie = res.headers.get("set-cookie");
                if (setCookie) {
                    const match = setCookie.match(/session_id=([^;]+)/);
                    if (match) this.sessionId = match[1];
                }

                log(`✅ Authenticated as UID: ${this.uid}`);
                return true;
            }

            throw new Error("Authentication failed: No UID returned");
        } catch (e) {
            log(`❌ Authentication exception: ${e}`);
            throw e;
        }
    }

    // Recherche dans Odoo
    async search(model: string, domain: any[]): Promise<any[]> {
        if (!this.sessionId) {
            throw new Error("Not authenticated. Call authenticate() first.");
        }

        const url = `${this.baseUrl}/web/dataset/call_kw`;
        const payload = {
            jsonrpc: "2.0",
            method: "call",
            params: {
                model: model,
                method: "search_read",
                args: [domain],
                kwargs: {
                    fields: ["id"],
                    limit: 1,
                },
            },
        };

        try {
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
                log(`⚠️ Search error in ${model}: ${JSON.stringify(data.error)}`);
                return [];
            }

            return data.result || [];
        } catch (e) {
            log(`❌ Search exception for ${model}: ${e}`);
            return [];
        }
    }

    // Création d'enregistrement dans Odoo
    async create(model: string, values: any): Promise<number | null> {
        if (!this.sessionId) {
            throw new Error("Not authenticated. Call authenticate() first.");
        }

        const url = `${this.baseUrl}/web/dataset/call_kw`;
        const payload = {
            jsonrpc: "2.0",
            method: "call",
            params: {
                model: model,
                method: "create",
                args: [values],
                kwargs: {},
            },
        };

        try {
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
                log(`❌ Create error in ${model}:  ${JSON.stringify(data.error)}`);
                return null;
            }

            return data.result;
        } catch (e) {
            log(`❌ Create exception for ${model}: ${e}`);
            return null;
        }
    }
}

// -----------------------
// 4. LOGIQUE METIER
// -----------------------

async function getOrCreateCustomer(odoo: OdooClient, order: any) {
    const billing = order.billing || {};
    let email = (billing.email || "").trim();

    // Validation de l'email
    if (!email || !isValidEmail(email)) {
        email = `no-email-wc${order.id}@placeholder.local`;
        log(`⚠️ Invalid/missing email for order ${order.id}, using:  ${email}`);
    }

    // Recherche du client existant
    const existing = await odoo.search("res.partner", [["email", "=", email]]);
    if (existing && existing.length > 0) {
        log(`✓ Customer found: ${email} (ID: ${existing[0].id})`);
        return existing[0].id;
    }

    // Création du client
    const firstName = (billing.first_name || "").trim();
    const lastName = (billing.last_name || "").trim();
    let fullName = `${firstName} ${lastName}`.trim();

    if (!fullName) {
        fullName = `Client WooCommerce #${order.id}`;
        log(`⚠️ Missing customer name for order ${order.id}, using: ${fullName}`);
    }

    const values = {
        name: fullName,
        email: email,
        phone: (billing.phone || "").trim() || false,
        street: (billing.address_1 || "").trim() || false,
        city: (billing.city || "").trim() || false,
        zip: (billing.postcode || "").trim() || false,
        country_id: 195, // Sénégal
        customer_rank: 1,
    };

    const customerId = await odoo.create("res.partner", values);
    if (customerId) {
        log(`✅ Customer created: ${fullName} (ID: ${customerId})`);
    }
    return customerId;
}

async function getOrCreateProduct(odoo: OdooClient, item: any) {
    let sku = (item.sku || "").trim();

    // Si pas de SKU, utiliser le nom comme référence
    if (!sku) {
        sku = `WC-${item.product_id || item.name.substring(0, 20)}`;
        log(`⚠️ Missing SKU for product "${item.name}", using: ${sku}`);
    }

    // Recherche du produit existant
    const existing = await odoo.search("product.product", [["default_code", "=", sku]]);
    if (existing && existing.length > 0) {
        log(`✓ Product found: ${sku} (ID: ${existing[0].id})`);
        return existing[0].id;
    }

    // Validation du prix
    const price = sanitizePrice(item.price);
    if (price === 0) {
        log(`⚠️ Invalid price for product "${item.name}", using 0`);
    }

    // Création du produit
    const values = {
        name: item.name || "Produit sans nom",
        list_price: price,
        default_code: sku,
        type: "consu",
        sale_ok: true,
    };

    const productId = await odoo.create("product.product", values);
    if (productId) {
        log(`✅ Product created: ${item.name} (ID: ${productId})`);
    }
    return productId;
}

async function syncOrder(odoo: OdooClient, order: any) {
    const wcId = order.id;
    const originTag = `WC-${wcId}`;

    // Vérifier si la commande existe déjà
    const existing = await odoo.search("sale.order", [["origin", "=", originTag]]);
    if (existing && existing.length > 0) {
        log(`⏩ Order ${originTag} already imported (Odoo ID: ${existing[0].id})`);
        return;
    }

    log(`🔄 Processing Order ${originTag}...`);

    // Créer ou récupérer le client
    const partnerId = await getOrCreateCustomer(odoo, order);
    if (!partnerId) {
        log(`❌ Failed to create/find customer for order ${originTag}, skipping. `);
        return;
    }

    // Vérifier qu'il y a des articles
    if (!order.line_items || order.line_items.length === 0) {
        log(`⚠️ Order ${originTag} has no line items, skipping.`);
        return;
    }

    // Créer les lignes de commande
    const orderLines = [];
    for (const item of order.line_items) {
        const productId = await getOrCreateProduct(odoo, item);
        if (productId) {
            const quantity = sanitizeQuantity(item.quantity);
            const price = sanitizePrice(item.price);

            const lineData = {
                product_id: productId,
                name: item.name || "Article",
                product_uom_qty: quantity,
                price_unit: price,
            };
            orderLines.push([0, 0, lineData]);
            log(`  ├─ Line:  ${item.name} x${quantity} @ ${price}`);
        } else {
            log(`  ├─ ⚠️ Failed to create product for item:  ${item.name}`);
        }
    }

    if (orderLines.length === 0) {
        log(`❌ No valid product lines for order ${originTag}, skipping. `);
        return;
    }

    // Créer la commande dans Odoo
    const rawDate = order.date_created || new Date().toISOString();
    // Odoo expects "YYYY-MM-DD HH:MM:SS", removing "T" and "Z"
    const odooDate = rawDate.replace("T", " ").replace("Z", "").split(".")[0];

    const orderValues = {
        partner_id: partnerId,
        origin: originTag,
        client_order_ref: String(wcId),
        state: "draft",
        order_line: orderLines,
        date_order: odooDate,
    };

    const newOrderId = await odoo.create("sale.order", orderValues);
    if (newOrderId) {
        log(`✅ SUCCESS: Order ${originTag} created in Odoo (ID: ${newOrderId})`);
    } else {
        log(`❌ FAILED: Could not create order ${originTag} in Odoo`);
    }
}

// -----------------------
// 5. MAIN HANDLER
// -----------------------

serve(async (_req) => {
    log("🚀 Starting WooCommerce → Odoo Sync Job...");

    // Vérifier les variables d'environnement
    if (!WC_CK || !WC_CS) {
        log("❌ Missing WooCommerce credentials (WOO_CK, WOO_CS)");
        return new Response("Missing WooCommerce credentials", { status: 500 });
    }

    if (!ODOO_USER || !ODOO_PASS) {
        log("❌ Missing Odoo credentials (ODOO_EMAIL, ODOO_PASSWORD)");
        return new Response("Missing Odoo credentials", { status: 500 });
    }

    // Initialiser et authentifier Odoo
    const odoo = new OdooClient(ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASS);

    try {
        await odoo.authenticate();
    } catch (e) {
        log(`❌ Odoo authentication failed: ${e}`);
        return new Response(`Odoo authentication failed: ${e}`, { status: 500 });
    }

    try {
        log("📡 Fetching WooCommerce orders...");
        // Removed status=processing to match V1 behavior (fetches all recent orders)
        const res = await fetch(`${WC_URL}/wp-json/wc/v3/orders?per_page=20`, {
            headers: {
                "Authorization": getWooAuth(),
            },
        });

        if (!res.ok) {
            const txt = await res.text();
            log(`❌ WooCommerce API Error (${res.status}): ${txt}`);
            return new Response(`WooCommerce Error: ${txt}`, { status: 500 });
        }

        const orders = await res.json();
        log(`🔎 Found ${orders.length} orders to process. `);

        if (orders.length === 0) {
            log("ℹ️ No orders to sync.");
            return new Response("No orders to sync", { status: 200 });
        }

        let successCount = 0;
        let skipCount = 0;
        let errorCount = 0;

        for (const order of orders) {
            try {
                const result = await syncOrder(odoo, order);
                if (result === undefined) {
                    // La fonction ne retourne rien en cas de succès ou skip
                    successCount++;
                }
            } catch (e) {
                log(`❌ Unexpected error processing order ${order.id}:  ${e}`);
                errorCount++;
            }
        }

        log("🏁 Sync finished.");
        log(`📊 Summary: ${successCount} processed, ${errorCount} errors`);

        return new Response(
            JSON.stringify({
                status: "completed",
                total: orders.length,
                processed: successCount,
                errors: errorCount,
            }),
            {
                status: 200,
                headers: { "Content-Type": "application/json" }
            }
        );

    } catch (e) {
        log(`❌ Fatal error: ${e}`);
        return new Response(`Fatal Error: ${e}`, { status: 500 });
    }
});