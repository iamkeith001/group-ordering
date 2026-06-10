import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
    addDoc,
    collection,
    doc,
    getDoc,
    getFirestore,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    setDoc,
    Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

// Configuration & Parameters
const params = new URLSearchParams(location.search);
const DEFAULT_REMOTE_API_BASE = 'https://claw.kht50.cc/starbucks/api/';
const BACKEND_MODE = params.get('backend') || (params.get('api') ? 'api' : 'firebase');
const API_BASE = params.get('api') || DEFAULT_REMOTE_API_BASE;
const firebaseConfig = {
    apiKey: 'AIzaSyDagyGwaESWrhkxPCzfxzvCucNxM5jSvrE',
    authDomain: 'group-ordering-keith-20260610.firebaseapp.com',
    projectId: 'group-ordering-keith-20260610',
    storageBucket: 'group-ordering-keith-20260610.firebasestorage.app',
    messagingSenderId: '831890094685',
    appId: '1:831890094685:web:5bce79be4626e8e03febb4'
};
const storeId = 'burgerking'; // Hardcoded to Burger King
const groupId = params.get('g') || 'g_demo';
const groupName = decodeURIComponent(params.get('n') || '測試點餐群組');
// 預設團購標題：開團時會自動帶入「團購標題」欄位，開團人可現場修改
const DEFAULT_TITLE = '漢堡王群組點餐';
// 預設 15 項餐點名：開團時會自動帶入「餐點名單」欄位，開團人可現場修改
const DEFAULT_MENU_ITEMS = [
    '華堡 (Whopper)',
    '雙層華堡 (Double Whopper)',
    '小華堡 (Whopper Jr.)',
    '辣味華堡 (Spicy Whopper)',
    '美式花生雙層牛肉堡',
    '勁濃培根雙層牛肉堡',
    '火烤雞腿堡',
    '華鱈魚堡',
    '脆洋蔥雙起司雞排堡',
    '經典薯條',
    '酥炸洋蔥圈',
    '炸雞塊 (Chicken Nuggets)',
    '可口可樂 (Coke)',
    '檸檬紅茶',
    '熱無糖紅茶'
];
// 常用點餐成員（依首字筆劃排序）：開團時會自動帶入「成員名單」欄位，開團人可現場增刪
const DEFAULT_MEMBERS = [
    'Keith',
    '成立',
    '芸汶',
    '怡惠',
    '欣博',
    '富哥',
    '智凱',
    '詩儀',
    '簡博',
    '瀞云'
];

// State Variables
let menuData = []; // Loaded dynamically from script
let cart = []; // [{name, img, qty}] — one person can order multiple items at once
let takenDrinks = {}; // itemName -> [array of names]
let allOrders = []; // Array of actual order objects {name, drink, img}
let currentCategory = 'all';
let searchQuery = '';
let isMockMode = false;
let syncInterval = null;
let firebaseUnsubscribe = null;
let hasRemoteConnectionError = false;
let groupWindow = null; // {openAt: Date|null, closeAt: Date|null} from groups/{groupId} doc
let groupMembers = null; // string[] from groups/{groupId}.members — when set, name input becomes a dropdown
let groupMenuItems = null; // string[] from groups/{groupId}.menuItems — editable menu item names
let groupTitle = DEFAULT_TITLE; // from groups/{groupId}.title — editable page title
const firebaseApp = initializeApp(firebaseConfig);
const firestoreDb = getFirestore(firebaseApp);

// DOM Elements
const elGroupName = document.getElementById('group-name');
const elSearchInput = document.getElementById('search-input');
const elCategoryTabs = document.getElementById('category-tabs');
const elMenuList = document.getElementById('menu-list');
const elPersonName = document.getElementById('person-name');
const elPersonNameSelect = document.getElementById('person-name-select');
const elSelectedCard = document.getElementById('selected-card');
const elSelectedDrinkPreview = document.getElementById('selected-drink-preview');
const elSubmitCard = document.getElementById('submit-card');
const elSubmitBtn = document.getElementById('submit-btn');
const elSummaryCountTotal = document.getElementById('summary-count-total');
const elStatPeople = document.getElementById('stat-people');
const elStatStyles = document.getElementById('stat-styles');
const elSummaryList = document.getElementById('summary-list');
const elSyncStatus = document.getElementById('sync-status');
const elSyncStatusText = document.getElementById('sync-status-text');
const elOrderWindowBanner = document.getElementById('order-window-banner');
const elWindowSetupCard = document.getElementById('window-setup-card');
const elWindowOpenInput = document.getElementById('window-open-input');
const elWindowCloseInput = document.getElementById('window-close-input');
const elWindowMembersInput = document.getElementById('window-members-input');
const elWindowMenuInput = document.getElementById('window-menu-input');
const elWindowTitleInput = document.getElementById('window-title-input');
const elWindowSetupBtn = document.getElementById('window-setup-btn');

// Success view elements
const elMainContainer = document.getElementById('main-container');
const elSuccessView = document.getElementById('success-view');
const elSuccessName = document.getElementById('success-name');
const elSuccessDrink = document.getElementById('success-drink');
const elSuccessContinueBtn = document.getElementById('success-continue-btn');
const elSuccessExitBtn = document.getElementById('success-exit-btn');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getLocalStorageKey() {
    return `order-mock-orders-${groupId}-${storeId}`;
}

function getLegacyLocalStorageKey() {
    return `sb-mock-orders-${groupId}-${storeId}`;
}

function readOrdersFromLocalStorage(key) {
    try {
        const orders = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(orders) ? orders : [];
    } catch (err) {
        console.warn(`Invalid local order cache for ${key}, resetting it.`, err);
        localStorage.setItem(key, JSON.stringify([]));
        return [];
    }
}

function shouldUseFirebase() {
    return !isMockMode && BACKEND_MODE === 'firebase';
}

function getFirebaseOrdersCollection() {
    return collection(firestoreDb, 'groups', groupId, 'orders');
}

// The menu is a flat editable list of item names (no fixed photos, since
// restaurant menus change over time)
function applyTitle() {
    document.title = `${groupTitle} - 選擇你的餐點`;
    document.querySelector('.header-wrapper h1').textContent = `🍔 ${groupTitle}`;
}

function buildMenuFromItems(items) {
    return [{
        category: '餐點',
        drinks: items.map(n => ({ name: n, img: '' }))
    }];
}

// Initialization
async function init() {
    // Set group name in UI
    elGroupName.textContent = groupName;

    // Detect if we should use Mock mode
    if (location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1' || groupId === 'g_demo') {
        isMockMode = true;
        console.log('💡 Activated Mock Mode (Local Test Environment)');
    }

    // Set page title (the group's own title overrides it once loaded)
    applyTitle();
    document.querySelector('.step-badge').innerHTML = `1️⃣ 步驟一：選擇餐點`;

    // Dynamic selected preview empty text placeholder
    document.querySelector('#selected-card h2').textContent = `🍔 已選項目`;
    document.querySelector('#selected-card .preview-empty-text').textContent = `請在下方選單點選您想點的餐點，可一次點多份`;

    // Start with the built-in editable menu; the group's own menuItems
    // (configured at setup time) override it once loaded
    menuData = buildMenuFromItems(DEFAULT_MENU_ITEMS);

    // Render category buttons dynamically
    renderCategoryTabs();

    // Name dropdown starts from the built-in member list; the group's own
    // list (if configured at setup time) overrides it once loaded.
    if (DEFAULT_MEMBERS.length > 0) {
        groupMembers = [...DEFAULT_MEMBERS];
        applyMemberSelect();
    }

    if (shouldUseFirebase()) {
        renderMenu();
        updateSummaryDashboard();
        startFirebaseSync();
        loadGroupWindow().then(() => {
            renderOrderWindowBanner();
            // Re-evaluate open/closed state as time passes
            setInterval(renderOrderWindowBanner, 30000);
        });
    } else {
        // Load initial orders
        syncData().then(() => {
            renderMenu();
            updateSummaryDashboard();
        });
    }

    // Setup Event Listeners
    setupEventListeners();

    if (!shouldUseFirebase()) {
        // Start 5s background synchronization for API / Mock mode
        syncInterval = setInterval(() => {
            showSyncingStatus(true);
            syncData().then(() => {
                updateMenuStates();
                updateSummaryDashboard();
                setTimeout(() => showSyncingStatus(false), 800);
            });
        }, 5000);
    }
}

// Event Listeners Binding
function setupEventListeners() {
    // Search input filtering
    elSearchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim().toLowerCase();
        renderMenu();
    });

    // Name input verification
    elPersonName.addEventListener('input', checkCanSubmit);
    elPersonNameSelect.addEventListener('change', checkCanSubmit);

    // Order submit
    elSubmitBtn.addEventListener('click', submitOrder);

    // Category Tabs switching
    elCategoryTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;

        // Update active tab styling
        elCategoryTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Apply filter
        currentCategory = btn.dataset.category;
        renderMenu();
    });

    // Cart interactions: quantity +/- and clear
    elSelectedDrinkPreview.addEventListener('click', (e) => {
        if (e.target.classList.contains('change-selection-btn')) {
            clearCart();
            return;
        }
        const qtyBtn = e.target.closest('.cart-qty-btn');
        if (qtyBtn) {
            changeCartQty(qtyBtn.dataset.name, qtyBtn.dataset.action === 'plus' ? 1 : -1);
        }
    });

    // Success dialog: reload page to support ordering for another person
    elSuccessContinueBtn.addEventListener('click', () => {
        location.reload();
    });

    // Done ordering: try to close the tab; if the browser blocks it,
    // show a farewell message instead
    elSuccessExitBtn.addEventListener('click', () => {
        window.close();
        setTimeout(() => {
            elSuccessView.innerHTML = `
                <div class="success-icon">👋</div>
                <h2>感謝點餐！</h2>
                <p>您的訂單已送出，可以關閉此頁面了。</p>
            `;
        }, 300);
    });
}

// Show live sync visual effect
function showSyncingStatus(isSyncing) {
    const dot = elSyncStatus.querySelector('.sync-dot-green');
    if (isSyncing) {
        elSyncStatusText.textContent = '正在同步點餐明細...';
        dot.classList.add('syncing');
        elSyncStatus.classList.add('active');
    } else {
        elSyncStatusText.textContent = hasRemoteConnectionError
            ? '雲端同步連線異常'
            : (isMockMode ? '點餐資訊已同步 (Mock 模式)' : '點餐資訊已即時同步');
        dot.classList.remove('syncing');
        elSyncStatus.classList.add('active');
        // Auto-fade out status badge after 3 seconds
        setTimeout(() => {
            elSyncStatus.classList.remove('active');
        }, 3000);
    }
}

// Generate tabs dynamically based on menu categories
function renderCategoryTabs() {
    // A single-category menu doesn't need filter tabs
    if (menuData.length <= 1) {
        elCategoryTabs.style.display = 'none';
        currentCategory = 'all';
        return;
    }
    elCategoryTabs.style.display = '';
    let html = `<button class="tab-btn active" data-category="all">全部</button>`;
    menuData.forEach(cat => {
        html += `<button class="tab-btn" data-category="${escapeHtml(cat.category)}">${escapeHtml(cat.category)}</button>`;
    });
    elCategoryTabs.innerHTML = html;
}

// Dynamic Menu Rendering
function renderMenu() {
    let filteredMenu = menuData;

    // Filter by Category Tab
    if (currentCategory !== 'all') {
        filteredMenu = menuData.filter(cat => cat.category === currentCategory);
    }

    let menuHTML = '';

    filteredMenu.forEach(cat => {
        const matchedDrinks = cat.drinks.filter(drink => 
            drink.name.toLowerCase().includes(searchQuery)
        );

        if (matchedDrinks.length === 0) return;

        menuHTML += `
        <div class="category-group">
            <h3 class="category-title">${escapeHtml(cat.category)}</h3>
            <div class="menu-list-items">
        `;

        matchedDrinks.forEach(drink => {
            const takers = takenDrinks[drink.name] || [];
            const isTaken = takers.length > 0;
            const cartItem = getCartItem(drink.name);
            const isSelected = !!cartItem;
            const safeName = escapeHtml(drink.name);
            const safeImg = escapeHtml(drink.img);
            const takerTags = takers.map(name => `<span class="taker-tag" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`).join('');

            menuHTML += `
                <div class="drink-card ${isTaken ? 'has-takers' : ''} ${isSelected ? 'selected-active' : ''}"
                     data-drink-name="${safeName}" data-drink-img="${safeImg}">
                    ${drink.img ? `<img class="drink-img" src="${safeImg}" alt="${safeName}" loading="lazy">` : `<div class="drink-img drink-img-placeholder">🍔</div>`}
                    <div class="drink-info">
                        <div class="drink-name-row">
                            <span class="drink-name">${safeName}</span>
                            ${isTaken ? `<span class="takers-count-badge">${takers.length} 人點了</span>` : ''}
                        </div>
                        ${isTaken ? `<div class="takers-list">👥 ${takerTags}</div>` : ''}
                    </div>
                    <div class="drink-action">
                        <button class="card-btn select-action-btn">${isSelected ? `已選 ×${cartItem.qty}` : '選擇'}</button>
                    </div>
                </div>
            `;
        });

        menuHTML += `
            </div>
        </div>
        `;
    });

    if (!menuHTML) {
        elMenuList.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.95rem;">無符合搜尋結果的品項 🔍</div>`;
    } else {
        elMenuList.innerHTML = menuHTML;
    }

    // Attach card click handlers programmatically
    elMenuList.querySelectorAll('.drink-card').forEach(card => {
        card.addEventListener('click', (e) => {
            const name = card.dataset.drinkName;
            const img = card.dataset.drinkImg;
            addToCart(name, img);
        });
    });
}

// Update menu DOM cards dynamically
function updateMenuStates() {
    elMenuList.querySelectorAll('.drink-card').forEach(card => {
        const name = card.dataset.drinkName;
        const takers = takenDrinks[name] || [];
        const isTaken = takers.length > 0;
        const cartItem = getCartItem(name);

        if (isTaken) {
            card.classList.add('has-takers');
        } else {
            card.classList.remove('has-takers');
        }

        if (cartItem) {
            card.classList.add('selected-active');
            card.querySelector('.select-action-btn').textContent = `已選 ×${cartItem.qty}`;
        } else {
            card.classList.remove('selected-active');
            card.querySelector('.select-action-btn').textContent = '選擇';
        }

        const nameRow = card.querySelector('.drink-name-row');
        let countBadge = nameRow.querySelector('.takers-count-badge');
        
        if (isTaken) {
            if (!countBadge) {
                countBadge = document.createElement('span');
                countBadge.className = 'takers-count-badge';
                nameRow.appendChild(countBadge);
            }
            countBadge.textContent = `${takers.length} 人點了`;
        } else if (countBadge) {
            countBadge.remove();
        }

        const infoDiv = card.querySelector('.drink-info');
        let listDiv = infoDiv.querySelector('.takers-list');

        if (isTaken) {
            const takerTags = takers.map(n => `<span class="taker-tag" title="${escapeHtml(n)}">${escapeHtml(n)}</span>`).join('');
            if (!listDiv) {
                listDiv = document.createElement('div');
                listDiv.className = 'takers-list';
                infoDiv.appendChild(listDiv);
            }
            listDiv.innerHTML = `👥 ${takerTags}`;
        } else if (listDiv) {
            listDiv.remove();
        }
    });
}

// Cart helpers: clicking a menu card adds one serving, +/- adjusts quantity
function getCartItem(name) {
    return cart.find(i => i.name === name);
}

function addToCart(name, img) {
    const item = getCartItem(name);
    if (item) {
        item.qty += 1;
    } else {
        cart.push({ name, img, qty: 1 });
    }
    renderCartPreview();
    updateMenuStates();
    checkCanSubmit();
}

function changeCartQty(name, delta) {
    const item = getCartItem(name);
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) {
        cart = cart.filter(i => i.name !== name);
    }
    renderCartPreview();
    updateMenuStates();
    checkCanSubmit();
}

function clearCart() {
    cart = [];
    renderCartPreview();
    updateMenuStates();
    checkCanSubmit();
}

function renderCartPreview() {
    if (cart.length === 0) {
        elSelectedDrinkPreview.innerHTML = `<span class="preview-empty-text">請在下方選單點選您想點的餐點，可一次點多份</span>`;
        elSelectedCard.classList.remove('show-selected');
        return;
    }

    const totalQty = cart.reduce((sum, i) => sum + i.qty, 0);
    const rows = cart.map(i => `
        <div class="cart-item">
            ${i.img ? `<img class="cart-item-img" src="${escapeHtml(i.img)}" alt="${escapeHtml(i.name)}" loading="lazy">` : `<div class="cart-item-img cart-item-img-placeholder">🍔</div>`}
            <span class="cart-item-name">${escapeHtml(i.name)}</span>
            <div class="cart-qty-controls">
                <button class="cart-qty-btn" data-action="minus" data-name="${escapeHtml(i.name)}">−</button>
                <span class="cart-qty">${i.qty}</span>
                <button class="cart-qty-btn" data-action="plus" data-name="${escapeHtml(i.name)}">＋</button>
            </div>
        </div>
    `).join('');

    elSelectedDrinkPreview.innerHTML = `
        <div class="cart-list">${rows}</div>
        <div class="cart-footer">
            <span class="cart-total">共 ${totalQty} 份</span>
            <button class="change-selection-btn">清空重選</button>
        </div>
    `;
    elSelectedCard.classList.add('show-selected');
}

// Form verification
function checkCanSubmit() {
    const name = getPersonName();
    if (name && cart.length > 0 && getOrderWindowState() === 'open') {
        elSubmitBtn.removeAttribute('disabled');
        elSubmitCard.classList.add('show-submit');
    } else {
        elSubmitBtn.setAttribute('disabled', 'true');
        elSubmitCard.classList.remove('show-submit');
    }
}

function startFirebaseSync() {
    showSyncingStatus(true);

    const ordersQuery = query(getFirebaseOrdersCollection(), orderBy('createdAt', 'asc'));
    firebaseUnsubscribe = onSnapshot(ordersQuery, (snapshot) => {
        allOrders = keepLatestBatchPerName(snapshot.docs.map(d => {
            const data = d.data();
            return {
                name: data.name || '',
                drink: data.drink || '',
                img: data.img || '',
                batch: data.batch || '',
                createdAt: data.createdAt || null
            };
        }));
        processOrdersToTakenMap(allOrders);
        hasRemoteConnectionError = false;
        updateMenuStates();
        updateSummaryDashboard();
        setTimeout(() => showSyncingStatus(false), 300);
    }, (err) => {
        console.error('Firebase sync failed', err);
        hasRemoteConnectionError = true;
        showRemoteConnectionError();
        showSyncingStatus(false);
    });
}

// Synchronize orders data from Server / LocalStorage
async function syncData() {
    if (isMockMode) {
        loadMockData();
        return;
    }

    try {
        const res = await fetch(`${API_BASE}get.php?g=${groupId}`);
        
        // If server returns 404, the group ID is unregistered in the database
        if (res.status === 404) {
            showGroupNotFoundError();
            return;
        }

        if (!res.ok) {
            throw new Error(`HTTP error! status: ${res.status}`);
        }

        const data = await res.json();
        
        if (data.success && data.orders) {
            hasRemoteConnectionError = false;
            allOrders = keepLatestBatchPerName(data.orders);
            processOrdersToTakenMap(allOrders);
        } else {
            throw new Error(data.error || 'API error response');
        }
    } catch (e) {
        console.error('Remote sync failed', e);
        hasRemoteConnectionError = true;
        showRemoteConnectionError();
    }
}

function showRemoteConnectionError() {
    elSummaryList.innerHTML = `<div style="text-align:center;padding:20px;color:#d32f2f;font-size:0.85rem;">雲端同步失敗，請稍後再試</div>`;
}

// Display group not found warning on the UI
function showGroupNotFoundError() {
    elMenuList.innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:var(--text-muted);">
            <div style="font-size:3rem;margin-bottom:16px;">⚠️</div>
            <h3 style="color:var(--text-main);margin-bottom:8px;font-size:1.1rem;">此點餐群組尚未啟用</h3>
            <p style="font-size:0.85rem;line-height:1.5;max-width:320px;margin:0 auto 20px;">
                網址中的群組 ID (g) 未在系統資料庫中註冊。請使用由您的系統或小幫手發起的正確連結！
            </p>
        </div>
    `;
    if (syncInterval) {
        clearInterval(syncInterval);
    }
    // Clear dashboard numbers
    elSummaryCountTotal.textContent = '0 份';
    elStatPeople.textContent = '0 人';
    elStatStyles.textContent = '0 種';
    elSummaryList.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:0.85rem;">群組未啟用 👥</div>`;
}


// Ordering window helpers: groups/{groupId} doc may define openAt/closeAt
async function loadGroupWindow() {
    try {
        const snap = await getDoc(doc(firestoreDb, 'groups', groupId));
        if (snap.exists()) {
            const data = snap.data();
            groupWindow = {
                openAt: data.openAt && data.openAt.toDate ? data.openAt.toDate() : null,
                closeAt: data.closeAt && data.closeAt.toDate ? data.closeAt.toDate() : null
            };
            if (Array.isArray(data.members) && data.members.length > 0) {
                groupMembers = data.members;
                applyMemberSelect();
            }
            if (Array.isArray(data.menuItems) && data.menuItems.length > 0) {
                groupMenuItems = data.menuItems;
                menuData = buildMenuFromItems(groupMenuItems);
                renderCategoryTabs();
                renderMenu();
            }
            if (typeof data.title === 'string' && data.title.trim()) {
                groupTitle = data.title.trim();
                applyTitle();
            }
        } else {
            showWindowSetupCard();
        }
    } catch (err) {
        console.warn('Failed to load group ordering window', err);
    }
}

// When the group defines a member list, names are picked from a dropdown
// instead of typed, so the overwrite-by-name logic can't be broken by typos.
function applyMemberSelect() {
    if (!groupMembers) return;
    const current = elPersonNameSelect.value;
    elPersonNameSelect.innerHTML = `<option value="">— 請選擇你的名字 —</option>`
        + groupMembers.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    if (current && groupMembers.includes(current)) {
        elPersonNameSelect.value = current;
    }
    elPersonNameSelect.style.display = '';
    elPersonName.style.display = 'none';
    checkCanSubmit();
}

function getPersonName() {
    if (groupMembers) return elPersonNameSelect.value.trim();
    return elPersonName.value.trim();
}

function toDatetimeLocalValue(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function showWindowSetupCard() {
    if (!elWindowSetupCard) return;
    const now = new Date();
    const close = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    elWindowOpenInput.value = toDatetimeLocalValue(now);
    elWindowCloseInput.value = toDatetimeLocalValue(close);
    elWindowTitleInput.value = DEFAULT_TITLE;
    elWindowMembersInput.value = DEFAULT_MEMBERS.join('\n');
    elWindowMenuInput.value = DEFAULT_MENU_ITEMS.join('\n');
    elWindowSetupCard.style.display = '';
    elWindowSetupBtn.addEventListener('click', submitWindowSetup);
}

async function submitWindowSetup() {
    const openAt = elWindowOpenInput.value ? new Date(elWindowOpenInput.value) : null;
    const closeAt = elWindowCloseInput.value ? new Date(elWindowCloseInput.value) : null;
    const members = [...new Set(
        elWindowMembersInput.value.split('\n').map(s => s.trim()).filter(Boolean)
    )];
    const menuItems = [...new Set(
        elWindowMenuInput.value.split('\n').map(s => s.trim()).filter(Boolean)
    )];
    const title = elWindowTitleInput.value.trim();

    if (!openAt || !closeAt || isNaN(openAt) || isNaN(closeAt)) {
        alert('請填寫完整的開團與截止時間。');
        return;
    }
    if (closeAt <= openAt) {
        alert('截止時間必須晚於開團時間。');
        return;
    }
    if (members.length === 0) {
        alert('請至少填寫一位點餐成員。');
        return;
    }
    if (members.some(m => m.length > 40)) {
        alert('成員名字最長 40 個字。');
        return;
    }
    if (!title) {
        alert('請填寫團購標題。');
        return;
    }
    if (menuItems.length === 0) {
        alert('請至少填寫一項餐點。');
        return;
    }
    if (menuItems.length > 50 || menuItems.some(m => m.length > 100)) {
        alert('餐點最多 50 項，每項名稱最長 100 個字。');
        return;
    }
    if (!confirm(`確定要設定本團期限嗎？\n開團：${formatWindowTime(openAt)}\n截止：${formatWindowTime(closeAt)}\n成員：${members.length} 人｜餐點：${menuItems.length} 項\n\n設定後不可修改。`)) {
        return;
    }

    elWindowSetupBtn.setAttribute('disabled', 'true');
    elWindowSetupBtn.querySelector('span').textContent = '正在建立...';

    try {
        await setDoc(doc(firestoreDb, 'groups', groupId), {
            openAt: Timestamp.fromDate(openAt),
            closeAt: Timestamp.fromDate(closeAt),
            title: title,
            members: members,
            menuItems: menuItems,
            createdAt: serverTimestamp()
        });
        groupWindow = { openAt, closeAt };
        groupTitle = title;
        applyTitle();
        groupMembers = members;
        applyMemberSelect();
        groupMenuItems = menuItems;
        menuData = buildMenuFromItems(groupMenuItems);
        renderCategoryTabs();
        renderMenu();
        elWindowSetupCard.style.display = 'none';
        renderOrderWindowBanner();
    } catch (err) {
        console.error('Failed to create group window', err);
        // Most likely another organizer created it first (create-once rule)
        await loadGroupWindow();
        if (groupWindow) {
            elWindowSetupCard.style.display = 'none';
            renderOrderWindowBanner();
            alert('本團期限已由其他人設定，已套用現有設定。');
        } else {
            alert('建立失敗，請確認網路後再試一次。');
            elWindowSetupBtn.removeAttribute('disabled');
            elWindowSetupBtn.querySelector('span').textContent = '建立開團期限';
        }
    }
}

function getOrderWindowState() {
    if (!groupWindow) return 'open';
    const now = new Date();
    if (groupWindow.openAt && now < groupWindow.openAt) return 'before';
    if (groupWindow.closeAt && now > groupWindow.closeAt) return 'closed';
    return 'open';
}

function formatWindowTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderOrderWindowBanner() {
    if (!elOrderWindowBanner) return;
    if (!groupWindow || (!groupWindow.openAt && !groupWindow.closeAt)) {
        elOrderWindowBanner.style.display = 'none';
        return;
    }
    const state = getOrderWindowState();
    const range = [
        groupWindow.openAt ? `${formatWindowTime(groupWindow.openAt)} 開團` : '',
        groupWindow.closeAt ? `${formatWindowTime(groupWindow.closeAt)} 截止` : ''
    ].filter(Boolean).join('｜');
    const stateText = state === 'before' ? '⏳ 尚未開團' : state === 'closed' ? '🔒 已截止收單' : '🟢 開放點餐中';
    const actionBtn = state === 'closed'
        ? `<button class="banner-action-btn" id="new-group-btn">🔄 開新團</button>`
        : `<button class="banner-action-btn" id="copy-link-btn">📋 複製連結</button>`;
    elOrderWindowBanner.innerHTML = `${stateText}　${range}${actionBtn}`;
    elOrderWindowBanner.dataset.state = state;
    elOrderWindowBanner.style.display = '';

    const newGroupBtn = document.getElementById('new-group-btn');
    if (newGroupBtn) newGroupBtn.addEventListener('click', startNewGroup);
    const copyLinkBtn = document.getElementById('copy-link-btn');
    if (copyLinkBtn) copyLinkBtn.addEventListener('click', copyGroupLink);

    checkCanSubmit();
}

// One-click new group: auto-generate an unused group id and jump to it;
// the setup card appears there with times and member list prefilled
function startNewGroup() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const defaultName = `${d.getMonth() + 1}/${d.getDate()}點餐`;
    const name = prompt('幫新團取個名稱：', defaultName);
    if (name === null) return;
    const newId = `t${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    location.href = `${location.pathname}?g=${newId}&n=${encodeURIComponent(name.trim() || defaultName)}`;
}

async function copyGroupLink() {
    const url = `${location.origin}${location.pathname}?g=${encodeURIComponent(groupId)}&n=${encodeURIComponent(groupName)}`;
    try {
        await navigator.clipboard.writeText(url);
        alert('已複製本團連結，貼到群組就能邀大家點餐！');
    } catch (err) {
        prompt('複製這個連結分享給大家：', url);
    }
}

// Orders are append-only; a re-submission is a new batch under the same name
// and overrides the old one. Keep only each name's latest batch (input is
// sorted oldest-first). Legacy records without a batch count as one-off
// batches, so only the newest single record survives for that name.
function keepLatestBatchPerName(orders) {
    const latestBatchByName = new Map();
    orders.forEach((o, idx) => {
        latestBatchByName.set(String(o.name || '').trim(), o.batch || `__single_${idx}`);
    });
    return orders.filter((o, idx) =>
        latestBatchByName.get(String(o.name || '').trim()) === (o.batch || `__single_${idx}`)
    );
}

// Process flat order array into drink mapping
function processOrdersToTakenMap(orders) {
    const map = {};
    orders.forEach(o => {
        if (!map[o.drink]) map[o.drink] = [];
        if (!map[o.drink].includes(o.name)) {
            map[o.drink].push(o.name);
        }
    });
    takenDrinks = map;
}

// Local mock database helpers
function loadMockData() {
    const localKey = getLocalStorageKey(); // Include storeId to isolate group orders between brands
    const legacyLocalKey = getLegacyLocalStorageKey();
    let mockData = localStorage.getItem(localKey);

    if (!mockData && localStorage.getItem(legacyLocalKey)) {
        mockData = localStorage.getItem(legacyLocalKey);
        localStorage.setItem(localKey, mockData);
    }
    
    if (!mockData) {
        const initialMock = [];
        localStorage.setItem(localKey, JSON.stringify(initialMock));
    }
    
    allOrders = keepLatestBatchPerName(readOrdersFromLocalStorage(localKey));
    processOrdersToTakenMap(allOrders);
}

// Update summary dashboard card
function updateSummaryDashboard() {
    const count = allOrders.length;
    const peopleCount = new Set(allOrders.map(o => String(o.name || '').trim())).size;
    elSummaryCountTotal.textContent = `${count} 份`;
    elStatPeople.textContent = `${peopleCount} 人`;

    const stylesCount = Object.keys(takenDrinks).length;
    elStatStyles.textContent = `${stylesCount} 種`;

    if (allOrders.length === 0) {
        elSummaryList.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:0.85rem;">目前尚無人點餐 👥</div>`;
    } else {
        const reversedOrders = [...allOrders].reverse();
        elSummaryList.innerHTML = reversedOrders.map(o => `
            <div class="summary-item">
                <span class="summary-item-name">👤 ${escapeHtml(o.name)}</span>
                <span class="summary-item-drink">${escapeHtml(o.drink)}</span>
            </div>
        `).join('');
    }
}

// Submit Order: the cart expands to one order record per serving
async function submitOrder() {
    const name = getPersonName();
    if (!name || cart.length === 0) return;

    const windowState = getOrderWindowState();
    if (windowState !== 'open') {
        alert(windowState === 'before' ? '尚未到開團時間，請稍後再點餐。' : '已超過收單期限，本團已截止點餐。');
        renderOrderWindowBanner();
        return;
    }

    elSubmitBtn.setAttribute('disabled', 'true');
    elSubmitBtn.querySelector('span').textContent = '正在送出點餐...';

    // All records of one submission share a batch id, so a later submission
    // by the same name replaces the whole batch at once.
    const batchId = (crypto.randomUUID && crypto.randomUUID())
        || `b${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const items = [];
    cart.forEach(i => {
        for (let k = 0; k < i.qty; k++) {
            items.push({ groupId: groupId, name: name, drink: i.name, img: i.img, batch: batchId });
        }
    });
    const summaryText = cart.map(i => `${i.name} ×${i.qty}`).join('、');

    if (isMockMode) {
        await new Promise(resolve => setTimeout(resolve, 800));

        const localKey = getLocalStorageKey();
        const currentMock = readOrdersFromLocalStorage(localKey);
        currentMock.push(...items);
        localStorage.setItem(localKey, JSON.stringify(currentMock));

        showSuccessScreen(name, summaryText);
        return;
    }

    if (shouldUseFirebase()) {
        try {
            for (const item of items) {
                await addDoc(getFirebaseOrdersCollection(), {
                    name: item.name,
                    drink: item.drink,
                    img: item.img,
                    batch: item.batch,
                    createdAt: serverTimestamp()
                });
            }

            showSuccessScreen(name, summaryText);
        } catch (err) {
            console.error('Firebase submit failed', err);
            alert('雲端送出失敗，請確認網路連線後再重試。');
            elSubmitBtn.removeAttribute('disabled');
            elSubmitBtn.querySelector('span').textContent = '確認送出點餐';
        }
        return;
    }

    try {
        for (const item of items) {
            const res = await fetch(`${API_BASE}order.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item)
            });
            const data = await res.json();
            if (!data.success) {
                throw new Error(data.error || '點餐送出失敗，請重試！');
            }
        }
        showSuccessScreen(name, summaryText);
    } catch (err) {
        console.error('Submit failed', err);
        alert(err.message || '雲端送出失敗，請確認網路連線後再重試。');
        elSubmitBtn.removeAttribute('disabled');
        elSubmitBtn.querySelector('span').textContent = '確認送出點餐';
    }
}

// Show Success dialog and transition
function showSuccessScreen(name, drinkName) {
    if (firebaseUnsubscribe) {
        firebaseUnsubscribe();
        firebaseUnsubscribe = null;
    }

    elSuccessName.textContent = name;
    elSuccessDrink.textContent = drinkName;

    elMainContainer.style.display = 'none';
    elSuccessView.classList.add('active');
}

// Initialize script execution
document.addEventListener('DOMContentLoaded', init);
