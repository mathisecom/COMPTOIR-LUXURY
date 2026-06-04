(function () {
  "use strict";

  var backendBaseUrl = window.COMPTOIR_EXTERNAL_CHECKOUT_URL;
  var isRedirecting = false;
  var discountStorageKey = "comptoir_luxury_discount_code";
  var directCartStorageKey = "comptoir_luxury_direct_checkout_cart";

  if (!backendBaseUrl) {
    return;
  }

  backendBaseUrl = String(backendBaseUrl).replace(/\/$/, "");
  renderCheckoutSuccessIfNeeded();
  renderCheckoutFormIfNeeded();
  renderStripeCheckoutIfNeeded();

  function isBuyNowTarget(element) {
    var text = "";
    try {
      text = String(element.closest("button, a, [role='button']")?.textContent || "").trim().toLowerCase();
    } catch (_error) {}

    return Boolean(
      element &&
        element.closest(
          [
            ".shopify-payment-button__button",
            ".shopify-payment-button__button--unbranded",
            ".shopify-payment-button button",
            "shopify-buy-it-now-button",
            "shopify-buy-it-now-button button",
            "shopify-accelerated-checkout",
            "shopify-accelerated-checkout-cart",
            "button[data-testid='Checkout-button']",
            "button[data-testid*='Buy']",
            "button[data-testid*='buy']",
            "[data-shopify='payment-button']",
            "[data-testid='ShopifyPay-button']",
          ].join(","),
        )
    ) || /^(acheter maintenant|buy it now|buy now)$/i.test(text);
  }

  function isCheckoutTarget(element) {
    if (!element) return false;
    if (element.closest('button[name="checkout"], input[name="checkout"], [data-testid="Checkout-button"]')) return true;

    var link = element.closest("a[href]");
    if (link) {
      try {
        var url = new URL(link.getAttribute("href"), window.location.origin);
        if (url.pathname === "/checkout" || url.pathname.indexOf("/checkout/") === 0 || url.pathname === "/checkouts" || url.pathname.indexOf("/checkouts/") === 0) {
          return true;
        }
      } catch (_error) {}
    }

    return isBuyNowTarget(element);
  }

  function neutralizeNativeCheckout() {
    var buttons = document.querySelectorAll('button[name="checkout"], input[name="checkout"], [data-testid="Checkout-button"], .shopify-payment-button__button, .shopify-payment-button button, shopify-accelerated-checkout, shopify-accelerated-checkout-cart');
    for (var i = 0; i < buttons.length; i += 1) {
      if (buttons[i].tagName === "BUTTON") buttons[i].setAttribute("type", "button");
      buttons[i].setAttribute("data-comptoir-external-checkout-trigger", "true");
      if (buttons[i].dataset.comptoirExternalCheckoutPatched === "1") continue;
      buttons[i].dataset.comptoirExternalCheckoutPatched = "1";
      buttons[i].addEventListener("click", handleCheckout, true);
    }

    var links = document.querySelectorAll('a[href*="/checkout"], a[href*="/checkouts"]');
    for (var j = 0; j < links.length; j += 1) {
      links[j].setAttribute("href", "/cart?external_checkout=1");
      if (links[j].dataset.comptoirExternalCheckoutPatched === "1") continue;
      links[j].dataset.comptoirExternalCheckoutPatched = "1";
      links[j].addEventListener("click", handleCheckout, true);
    }

    var forms = document.querySelectorAll('form[action*="/checkout"], form[action*="/checkouts"]');
    for (var k = 0; k < forms.length; k += 1) {
      forms[k].setAttribute("action", "/cart");
      forms[k].setAttribute("data-comptoir-native-checkout-blocked", "true");
    }
  }

  function startObserver() {
    neutralizeNativeCheckout();
    var attempts = 0;
    var interval = window.setInterval(function () {
      neutralizeNativeCheckout();
      attempts += 1;
      if (attempts > 50) window.clearInterval(interval);
    }, 200);

    if (typeof MutationObserver !== "undefined") {
      var observer = new MutationObserver(neutralizeNativeCheckout);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      window.setTimeout(function () { observer.disconnect(); }, 15000);
    }
  }

  async function handleCheckout(event, force) {
    if (isRedirecting || (!force && !isCheckoutTarget(event.target))) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    isRedirecting = true;
    showOverlay();

    try {
      await addCurrentProductFormToCart(event.target);
      var cart = await readCheckoutCart();
      if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
        showCheckoutError("Votre panier est vide. Ajoutez un article avant de lancer le paiement.");
        return;
      }
      window.location.href = "/cart?external_checkout=1";
    } catch (_error) {
      showCheckoutError("Le paiement n'a pas pu être préparé. Aucun checkout Shopify natif ne sera lancé. Merci de réessayer depuis votre panier.");
      isRedirecting = false;
    }
  }

  async function readCart() {
    var response = await fetch("/cart.js", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Unable to read Shopify cart.");
    return response.json();
  }

  function readCheckoutCart() {
    var directCart = readDirectCheckoutCart();
    if (directCart) return Promise.resolve(directCart);
    return readCart();
  }

  function readDirectCheckoutCart() {
    try {
      var params = new URLSearchParams(window.location.search);
      if (params.get("direct_checkout") !== "1") return null;
      var cart = JSON.parse(sessionStorage.getItem(directCartStorageKey) || "null");
      if (!cart || !Array.isArray(cart.items) || !cart.items.length) return null;
      return cart;
    } catch (_error) {
      return null;
    }
  }

  function storeDirectCheckoutCart(cart) {
    try {
      sessionStorage.setItem(directCartStorageKey, JSON.stringify(cart));
    } catch (_error) {}
  }

  async function addCurrentProductFormToCart(target) {
    if (!isBuyNowTarget(target)) return;
    var form = target.closest("form") || document.querySelector('form[action*="/cart/add"]');
    if (!form || !(form instanceof HTMLFormElement) || String(form.getAttribute("action") || "").indexOf("/cart/add") === -1) return;

    var response = await fetch("/cart/add.js", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" }, body: new FormData(form) });
    if (!response.ok) throw new Error("Unable to add current product to cart.");
  }

  async function createExternalCheckout(cart, customer) {
    var response = await fetch(backendBaseUrl + "/api/create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        cart: cart,
        currency: window.Shopify && window.Shopify.currency ? window.Shopify.currency.active : undefined,
        discount_code: readDiscountCode(),
        customer: customer,
      }),
    });

    if (!response.ok) throw new Error("External checkout failed.");
    return response.json();
  }

  async function renderCheckoutFormIfNeeded() {
    var params = new URLSearchParams(window.location.search);
    if (params.get("external_checkout") !== "1") return;

    var main = document.getElementById("MainContent") || document.querySelector("main");
    if (!main) {
      window.setTimeout(renderCheckoutFormIfNeeded, 50);
      return;
    }

    injectStyles();
    main.innerHTML = checkoutFormMarkup();
    bindCheckoutForm();

    try {
      var cart = await readCheckoutCart();
      if (!cart || !cart.items || !cart.items.length) {
        document.getElementById("comptoir-checkout-items").innerHTML = '<p class="comptoir-checkout__error">Votre panier est vide.</p>';
        return;
      }
      renderCartSummary(cart);
    } catch (_error) {
      document.getElementById("comptoir-checkout-items").innerHTML = '<p class="comptoir-checkout__error">Impossible de charger votre panier.</p>';
    }
  }

  function checkoutFormMarkup() {
    return '' +
      '<section class="comptoir-checkout">' +
        '<div class="comptoir-checkout__main">' +
          '<div class="comptoir-checkout__head"><p>Le Comptoir Luxury</p><h1>Finaliser la commande</h1></div>' +
          '<form id="comptoir-delivery-form" class="comptoir-checkout__form">' +
            '<h2>Livraison</h2>' +
            '<div class="comptoir-field comptoir-field--half"><label>Prénom<input name="first_name" autocomplete="given-name" required></label><label>Nom<input name="last_name" autocomplete="family-name" required></label></div>' +
            '<label>Adresse<input name="address1" autocomplete="address-line1" required></label>' +
            '<label>Appartement, suite, etc. <span>Optionnel</span><input name="address2" autocomplete="address-line2"></label>' +
            '<div class="comptoir-field comptoir-field--half"><label>Code postal<input name="zip" autocomplete="postal-code" required></label><label>Ville<input name="city" autocomplete="address-level2" required></label></div>' +
            '<label>Téléphone<input name="phone" autocomplete="tel" required></label>' +
            '<label>Email <span>Optionnel</span><input name="email" type="email" autocomplete="email"></label>' +
            '<input type="hidden" name="country_code" value="FR">' +
            '<h2>Code promo</h2>' +
            '<label>Code de réduction <span>Optionnel</span><input id="comptoir-discount-code" name="discount_code" autocomplete="off" placeholder="Indiquez votre code"></label>' +
            '<p id="comptoir-checkout-message" class="comptoir-checkout__message"></p>' +
            '<button type="submit">Continuer vers le paiement</button>' +
          '</form>' +
        '</div>' +
        '<aside class="comptoir-checkout__summary">' +
          '<h2>Votre commande</h2>' +
          '<div id="comptoir-checkout-items"><p>Chargement du panier...</p></div>' +
          '<div id="comptoir-checkout-totals" class="comptoir-checkout__totals"></div>' +
        '</aside>' +
      '</section>';
  }

  function bindCheckoutForm() {
    var form = document.getElementById("comptoir-delivery-form");
    var discountInput = document.getElementById("comptoir-discount-code");
    if (discountInput) discountInput.value = readDiscountCode();
    if (!form) return;

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var message = document.getElementById("comptoir-checkout-message");
      var submit = form.querySelector('button[type="submit"]');
      if (message) message.textContent = "Préparation du paiement sécurisé...";
      if (submit) submit.disabled = true;

      try {
        var formData = new FormData(form);
        storeDiscountCode(String(formData.get("discount_code") || "").trim().slice(0, 80));
        var customer = {
          email: String(formData.get("email") || "").trim(),
          first_name: String(formData.get("first_name") || "").trim(),
          last_name: String(formData.get("last_name") || "").trim(),
          phone: String(formData.get("phone") || "").trim(),
          shipping_address: {
            first_name: String(formData.get("first_name") || "").trim(),
            last_name: String(formData.get("last_name") || "").trim(),
            address1: String(formData.get("address1") || "").trim(),
            address2: String(formData.get("address2") || "").trim(),
            zip: String(formData.get("zip") || "").trim(),
            city: String(formData.get("city") || "").trim(),
            country_code: String(formData.get("country_code") || "FR").trim(),
            phone: String(formData.get("phone") || "").trim(),
          },
        };
        var cart = await readCheckoutCart();
        var checkout = await createExternalCheckout(cart, customer);
        if (!checkout || !checkout.session_id) throw new Error("Missing checkout session.");
        window.location.href = "/cart?external_checkout_session=" + encodeURIComponent(checkout.session_id) + "&checkout_token=" + encodeURIComponent(checkout.checkout_token || "");
      } catch (_error) {
        if (message) message.textContent = "Impossible de préparer le paiement. Vérifiez vos informations et votre code promo.";
        if (submit) submit.disabled = false;
      }
    });
  }

  async function renderStripeCheckoutIfNeeded() {
    var params = new URLSearchParams(window.location.search);
    var sessionId = params.get("external_checkout_session");
    var checkoutToken = params.get("checkout_token") || "";
    if (!sessionId) return;

    var main = document.getElementById("MainContent") || document.querySelector("main");
    if (!main) {
      window.setTimeout(renderStripeCheckoutIfNeeded, 50);
      return;
    }

    injectStyles();
    main.innerHTML = '' +
      '<section class="comptoir-checkout comptoir-checkout--payment">' +
        '<aside class="comptoir-checkout__summary"><h2>Votre commande</h2><div id="comptoir-stripe-items"><p>Chargement...</p></div><div id="comptoir-stripe-totals" class="comptoir-checkout__totals"></div></aside>' +
        '<div class="comptoir-checkout__payment"><div class="comptoir-checkout__head"><p>Le Comptoir Luxury</p><h1>Paiement sécurisé</h1></div><div id="comptoir-stripe-checkout"><p>Chargement du paiement...</p></div><p>Paiement sécurisé. Vos informations de livraison ont été enregistrées.</p></div>' +
      '</section>';

    try {
      var responses = await Promise.all([
        fetch(backendBaseUrl + "/api/checkout-session-client-secret?session_id=" + encodeURIComponent(sessionId) + "&checkout_token=" + encodeURIComponent(checkoutToken)),
        fetch(backendBaseUrl + "/api/checkout-summary?session_id=" + encodeURIComponent(sessionId) + "&checkout_token=" + encodeURIComponent(checkoutToken)),
      ]);
      var secret = await responses[0].json();
      var summary = await responses[1].json();
      if (responses[1].ok) renderServerSummary(summary, "comptoir-stripe-items", "comptoir-stripe-totals");
      if (!responses[0].ok || !secret.clientSecret || !secret.publishableKey) throw new Error("Missing Stripe secret.");
      await loadStripeJs();
      var stripe = window.Stripe(secret.publishableKey);
      var checkout = await stripe.initEmbeddedCheckout({
        clientSecret: secret.clientSecret,
        onComplete: async function () {
          await clearShopifyCart();
          window.location.href = "/cart?external_checkout_success=1&checkout_ref=" + encodeURIComponent(secret.checkout_ref || "") + "&session_id=" + encodeURIComponent(sessionId) + "&checkout_token=" + encodeURIComponent(checkoutToken);
        },
      });
      document.getElementById("comptoir-stripe-checkout").innerHTML = "";
      checkout.mount("#comptoir-stripe-checkout");
    } catch (_error) {
      document.getElementById("comptoir-stripe-checkout").innerHTML = '<p class="comptoir-checkout__error">Impossible de charger le paiement. Merci de réessayer depuis votre panier.</p>';
    }
  }

  async function renderCheckoutSuccessIfNeeded() {
    var params = new URLSearchParams(window.location.search);
    if (params.get("external_checkout_success") !== "1") return;
    await clearShopifyCart();
    var main = document.getElementById("MainContent") || document.querySelector("main");
    if (!main) {
      window.setTimeout(renderCheckoutSuccessIfNeeded, 50);
      return;
    }
    injectStyles();
    main.innerHTML = '<section class="comptoir-checkout comptoir-checkout--success"><div class="comptoir-checkout__success"><p>Le Comptoir Luxury</p><h1>Paiement confirmé</h1><strong id="comptoir-order-number">Commande en cours de génération...</strong><span id="comptoir-order-status">Votre paiement est confirmé. Nous finalisons votre commande.</span><a href="/">Retour à la boutique</a></div></section>';
    updateSuccessOrderNumber(params);
  }

  async function updateSuccessOrderNumber(params) {
    var orderNumber = document.getElementById("comptoir-order-number");
    var orderStatus = document.getElementById("comptoir-order-status");
    var sessionId = params.get("session_id") || "";
    var checkoutToken = params.get("checkout_token") || "";
    for (var attempt = 0; sessionId && checkoutToken && attempt < 24; attempt += 1) {
      try {
        var response = await fetch(backendBaseUrl + "/api/checkout-status?session_id=" + encodeURIComponent(sessionId) + "&checkout_token=" + encodeURIComponent(checkoutToken));
        var status = await response.json();
        if (response.ok && status.shopify_order_name) {
          orderNumber.textContent = "Commande " + status.shopify_order_name;
          orderStatus.textContent = "Votre commande a bien été validée.";
          return;
        }
      } catch (_error) {}
      await wait(1500);
    }
    orderNumber.textContent = params.get("checkout_ref") ? "Référence " + params.get("checkout_ref") : "Paiement confirmé";
    orderStatus.textContent = "Votre commande a bien été validée.";
  }

  function renderCartSummary(cart) {
    var items = (cart.items || []).map(function (item) {
      return {
        title: item.product_title || item.title || "Article",
        quantity: item.quantity,
        image: item.image,
        line_amount: item.final_line_price || item.line_price || 0,
        options: (item.options_with_values || []).map(function (option) { return option.name + " : " + option.value; }),
      };
    });
    renderItems(items, "comptoir-checkout-items");
    document.getElementById("comptoir-checkout-totals").innerHTML = '<div><span>Sous-total</span><strong>' + formatMoney(cart.total_price, cart.currency || "EUR") + '</strong></div>';
  }

  function renderServerSummary(summary, itemsId, totalsId) {
    renderItems(summary.items || [], itemsId);
    document.getElementById(totalsId).innerHTML =
      '<div><span>Sous-total</span><span>' + formatMoney(summary.original_amount_total || summary.amount_total, summary.currency) + '</span></div>' +
      (summary.discount ? '<div><span>Code ' + escapeHtml(summary.discount.code) + '</span><span>-' + formatMoney(summary.discount.discount_amount, summary.currency) + '</span></div>' : '') +
      '<div><strong>Total</strong><strong>' + formatMoney(summary.amount_total, summary.currency) + '</strong></div>';
  }

  function renderItems(items, mountId) {
    document.getElementById(mountId).innerHTML = items.map(function (item) {
      return '<article class="comptoir-checkout__item"><img src="' + escapeAttr(item.image || "") + '" alt=""><div><h3>' + escapeHtml(item.title || "Article") + '</h3><p>Quantité ' + escapeHtml(item.quantity) + '</p>' + (item.options && item.options.length ? '<p>' + item.options.map(escapeHtml).join(' · ') + '</p>' : '') + '</div><strong>' + formatMoney(item.line_amount, "EUR") + '</strong></article>';
    }).join("");
  }

  function readDiscountCode() {
    var input = document.getElementById("comptoir-discount-code");
    var code = input ? input.value : "";
    if (!code) {
      try { code = sessionStorage.getItem(discountStorageKey) || ""; } catch (_error) {}
    }
    return String(code || "").trim().slice(0, 80);
  }

  function storeDiscountCode(code) {
    try {
      if (code) sessionStorage.setItem(discountStorageKey, code);
      else sessionStorage.removeItem(discountStorageKey);
    } catch (_error) {}
  }

  function showOverlay() {
    if (document.getElementById("external-checkout-overlay")) return;
    var overlay = document.createElement("div");
    overlay.id = "external-checkout-overlay";
    overlay.innerHTML = '<div aria-label="Préparation du paiement"></div>';
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.82);backdrop-filter:blur(4px)";
    overlay.firstChild.style.cssText = "width:42px;height:42px;border:3px solid rgba(0,0,0,.14);border-top-color:#000;border-radius:999px;animation:external-checkout-spin .75s linear infinite";
    if (!document.getElementById("external-checkout-style")) {
      var style = document.createElement("style");
      style.id = "external-checkout-style";
      style.textContent = "@keyframes external-checkout-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(style);
    }
    document.body.appendChild(overlay);
  }

  function removeOverlay() {
    var overlay = document.getElementById("external-checkout-overlay");
    if (overlay) overlay.remove();
  }

  function showCheckoutError(message) {
    removeOverlay();
    window.alert(message);
  }

  function injectStyles() {
    if (document.getElementById("comptoir-external-checkout-styles")) return;
    var style = document.createElement("style");
    style.id = "comptoir-external-checkout-styles";
    style.textContent = ".comptoir-checkout{max-width:1180px;margin:0 auto;padding:32px 18px 56px;display:grid;grid-template-columns:minmax(0,1fr) minmax(390px,500px);gap:28px;align-items:start}.comptoir-checkout__main,.comptoir-checkout__summary,.comptoir-checkout__payment,.comptoir-checkout__success{border:1px solid rgba(0,0,0,.12);background:#fff}.comptoir-checkout__summary{background:#f8f7f4}.comptoir-checkout__head{padding:20px;border-bottom:1px solid rgba(0,0,0,.1)}.comptoir-checkout__head p,.comptoir-checkout__success p{margin:0 0 6px;text-transform:uppercase;letter-spacing:.08em;font-size:12px;color:#666}.comptoir-checkout h1{margin:0;font-size:28px;line-height:1.08}.comptoir-checkout h2{margin:0 0 14px;font-size:16px}.comptoir-checkout__form{padding:20px;display:grid;gap:14px}.comptoir-field--half{display:grid;grid-template-columns:1fr 1fr;gap:12px}.comptoir-checkout label{display:grid;gap:7px;font-size:13px;font-weight:600}.comptoir-checkout label span{font-weight:400;color:#777}.comptoir-checkout input{width:100%;border:1px solid rgba(0,0,0,.18);border-radius:0;padding:13px 12px;font:inherit;background:#fff;color:#000}.comptoir-checkout__form button,.comptoir-checkout__success a{border:1px solid #000;background:#000;color:#fff;padding:14px 16px;text-decoration:none;text-align:center;font:inherit;font-weight:700;cursor:pointer}.comptoir-checkout__form button:disabled{opacity:.55;cursor:wait}.comptoir-checkout__message,.comptoir-checkout__payment p{margin:0;color:#666;font-size:13px;line-height:1.45}.comptoir-checkout__summary{padding:20px;position:sticky;top:18px}.comptoir-checkout__item{display:grid;grid-template-columns:70px minmax(0,1fr) auto;gap:12px;padding:14px 0;border-bottom:1px solid rgba(0,0,0,.1)}.comptoir-checkout__item img{width:70px;height:86px;object-fit:cover;background:#eee}.comptoir-checkout__item h3{margin:0 0 4px;font-size:14px;line-height:1.3}.comptoir-checkout__item p{margin:0 0 3px;color:#666;font-size:12px}.comptoir-checkout__item strong{font-size:14px;white-space:nowrap}.comptoir-checkout__totals{display:grid;gap:10px;padding-top:16px}.comptoir-checkout__totals div{display:flex;justify-content:space-between;gap:18px;color:#666;font-size:14px}.comptoir-checkout__totals strong{color:#000;font-size:18px}.comptoir-checkout__payment{padding:20px}.comptoir-checkout--success{grid-template-columns:minmax(0,680px);justify-content:center}.comptoir-checkout__success{padding:24px;display:grid;gap:12px}.comptoir-checkout__success h1{font-size:30px}.comptoir-checkout__success strong{font-size:20px}.comptoir-checkout__error{color:#a32220!important}@media(max-width:900px){.comptoir-checkout{grid-template-columns:1fr;padding:18px 12px 40px}.comptoir-checkout__summary{position:static;order:-1}.comptoir-field--half{grid-template-columns:1fr}.comptoir-checkout__item{grid-template-columns:62px minmax(0,1fr);gap:10px}.comptoir-checkout__item img{width:62px;height:78px}.comptoir-checkout__item strong{grid-column:2}}";
    document.head.appendChild(style);
  }

  function loadStripeJs() {
    if (window.Stripe) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  async function clearShopifyCart() {
    try { await fetch("/cart/clear.js", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" } }); } catch (_error) {}
    try { sessionStorage.removeItem(directCartStorageKey); } catch (_error) {}
  }

  function handleDirectProductSubmit(event) {
    var form = event.target;
    if (!form || !(form instanceof HTMLFormElement) || isRedirecting) return false;
    var action = form.getAttribute("action") || "";
    if (action.indexOf("/cart/add") === -1) return false;

    var cart = buildDirectCartFromProductForm(form);
    if (!cart) return false;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    isRedirecting = true;
    showOverlay();
    storeDirectCheckoutCart(cart);
    window.location.href = "/cart?external_checkout=1&direct_checkout=1";
    return true;
  }

  function buildDirectCartFromProductForm(form) {
    try {
      var formData = new FormData(form);
      var variantId = Number(formData.get("id") || 0);
      var quantity = Number(formData.get("quantity") || 1);
      if (!Number.isFinite(variantId) || variantId <= 0 || !Number.isFinite(quantity) || quantity <= 0) return null;
      quantity = Math.min(Math.max(Math.round(quantity), 1), 99);

      var variant = readVariantFromPage(variantId) || {};
      var productTitle = readProductTitle();
      var variantTitle = variant.public_title || variant.title || "";
      var title = variant.name || [productTitle, variantTitle].filter(Boolean).join(" - ") || "Article";
      var unitPrice = Number(variant.price || 0);
      var linePrice = unitPrice * quantity;

      return {
        currency: window.Shopify && window.Shopify.currency ? window.Shopify.currency.active : "EUR",
        total_price: linePrice,
        items: [
          {
            id: variantId,
            variant_id: variantId,
            product_id: Number(formData.get("product-id") || variant.product_id || 0) || undefined,
            quantity: quantity,
            title: title,
            product_title: productTitle || title,
            variant_title: variantTitle,
            options_with_values: variantTitle ? [{ name: "Taille", value: variantTitle }] : [],
            price: unitPrice,
            line_price: linePrice,
            final_line_price: linePrice,
            image: readProductImage(),
            properties: {},
          },
        ],
      };
    } catch (_error) {
      return null;
    }
  }

  function readVariantFromPage(variantId) {
    var scripts = document.querySelectorAll('script[type="application/json"]');
    for (var i = 0; i < scripts.length; i += 1) {
      var text = scripts[i].textContent || "";
      if (text.indexOf(String(variantId)) === -1) continue;
      try {
        var data = JSON.parse(text);
        if (data && String(data.id) === String(variantId)) return data;
        if (Array.isArray(data)) {
          var variant = data.find(function (item) { return String(item && item.id) === String(variantId); });
          if (variant) return variant;
        }
      } catch (_error) {}
    }
    return null;
  }

  function readProductTitle() {
    var heading = document.querySelector("h1");
    return heading ? String(heading.textContent || "").trim() : "";
  }

  function readProductImage() {
    var image = document.querySelector(".product-gallery img, product-gallery img, main img");
    return image ? String(image.currentSrc || image.src || "") : "";
  }

  function wait(ms) { return new Promise(function (resolve) { window.setTimeout(resolve, ms); }); }
  function formatMoney(cents, currency) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: String(currency || "EUR").toUpperCase() }).format(Number(cents || 0) / 100); }
  function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, function (char) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]; }); }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }

  document.addEventListener("click", handleCheckout, true);
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || !(form instanceof HTMLFormElement)) return;
    if (handleDirectProductSubmit(event)) return;
    var action = form.getAttribute("action") || "";
    var hasCheckoutSubmitter = event.submitter && event.submitter.matches && event.submitter.matches('[name="checkout"]');
    var hasCheckoutButton = form.querySelector('[name="checkout"]');
    if (hasCheckoutSubmitter || hasCheckoutButton || /\/checkouts?(?:\/)?$/.test(action)) handleCheckout(event, true);
  }, true);

  window.addEventListener("pageshow", function () { isRedirecting = false; removeOverlay(); });
  window.addEventListener("pagehide", removeOverlay);
  startObserver();
})();
