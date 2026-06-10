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

// State Variables
let menuData = []; // Loaded dynamically from script
let selectedDrink = null;
let takenDrinks = {}; // itemName -> [array of names]
let allOrders = []; // Array of actual order objects {name, drink, img}
let currentCategory = 'all';
let searchQuery = '';
let isMockMode = false;
let syncInterval = null;
let firebaseUnsubscribe = null;
let hasRemoteConnectionError = false;
let groupWindow = null; // {openAt: Date|null, closeAt: Date|null} from groups/{groupId} doc
const firebaseApp = initializeApp(firebaseConfig);
const firestoreDb = getFirestore(firebaseApp);

// DOM Elements
const elGroupName = document.getElementById('group-name');
const elSearchInput = document.getElementById('search-input');
const elCategoryTabs = document.getElementById('category-tabs');
const elMenuList = document.getElementById('menu-list');
const elPersonName = document.getElementById('person-name');
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
const elWindowSetupBtn = document.getElementById('window-setup-btn');

// Success view elements
const elMainContainer = document.getElementById('main-container');
const elSuccessView = document.getElementById('success-view');
const elSuccessName = document.getElementById('success-name');
const elSuccessDrink = document.getElementById('success-drink');
const elSuccessContinueBtn = document.getElementById('success-continue-btn');

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

// Helper to load external javascript files locally without CORS errors
function loadMenuScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Failed to load: ${src}`));
        document.head.appendChild(script);
    });
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

    // Set Brand Headers
    const brand = { name: '漢堡王', emoji: '🍔', categoryLabel: '選擇餐點' };
    
    document.title = `${brand.name}群組點餐 - 選擇你的餐點`;
    document.querySelector('.header-wrapper h1').innerHTML = `${brand.emoji} ${brand.name}群組點餐`;
    document.querySelector('.step-badge').innerHTML = `1️⃣ 步驟一：${brand.categoryLabel}`;
    
    // Dynamic selected preview empty text placeholder
    document.querySelector('#selected-card h2').textContent = `${brand.emoji} 已選項目`;
    document.querySelector('#selected-card .preview-empty-text').textContent = `請在下方選單點選您想點的${brand.categoryLabel.slice(2)}`;

    try {
        // Load menu configuration script dynamically instead of fetch to avoid file:// protocol CORS blocks
        await loadMenuScript(`menu/${storeId}.js?v=2`);
        menuData = window[`${storeId}Menu`] || [];
    } catch (err) {
        console.error(`Failed to load menu script: menu/${storeId}.js`, err);
        elMenuList.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.95rem;">❌ 載入菜單失敗，請確認 /menu/${storeId}.js 檔案是否存在！</div>`;
        return;
    }

    // Render category buttons dynamically
    renderCategoryTabs();

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

    // Re-select / reset selection event
    elSelectedDrinkPreview.addEventListener('click', (e) => {
        if (e.target.classList.contains('change-selection-btn')) {
            clearSelection();
        }
    });

    // Success dialog: reload page to support ordering for another person
    elSuccessContinueBtn.addEventListener('click', () => {
        location.reload();
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
            const isSelected = selectedDrink && selectedDrink.name === drink.name;
            const safeName = escapeHtml(drink.name);
            const safeImg = escapeHtml(drink.img);
            const takerTags = takers.map(name => `<span class="taker-tag" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`).join('');

            menuHTML += `
                <div class="drink-card ${isTaken ? 'has-takers' : ''} ${isSelected ? 'selected-active' : ''}" 
                     data-drink-name="${safeName}" data-drink-img="${safeImg}">
                    <img class="drink-img" src="${safeImg}" alt="${safeName}" loading="lazy">
                    <div class="drink-info">
                        <div class="drink-name-row">
                            <span class="drink-name">${safeName}</span>
                            ${isTaken ? `<span class="takers-count-badge">${takers.length} 人點了</span>` : ''}
                        </div>
                        ${isTaken ? `<div class="takers-list">👥 ${takerTags}</div>` : ''}
                    </div>
                    <div class="drink-action">
                        <button class="card-btn select-action-btn">${isSelected ? '已選 ✓' : '選擇'}</button>
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
            selectDrink(name, img);
        });
    });
}

// Update menu DOM cards dynamically
function updateMenuStates() {
    elMenuList.querySelectorAll('.drink-card').forEach(card => {
        const name = card.dataset.drinkName;
        const takers = takenDrinks[name] || [];
        const isTaken = takers.length > 0;
        const isSelected = selectedDrink && selectedDrink.name === name;

        if (isTaken) {
            card.classList.add('has-takers');
        } else {
            card.classList.remove('has-takers');
        }

        if (isSelected) {
            card.classList.add('selected-active');
            card.querySelector('.select-action-btn').textContent = '已選 ✓';
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

// Select Drink
function selectDrink(name, img) {
    selectedDrink = { name, img };
    const safeName = escapeHtml(name);
    const safeImg = escapeHtml(img);

    // Update selected preview
    elSelectedDrinkPreview.innerHTML = `
        <img class="preview-img" src="${safeImg}" alt="${safeName}">
        <div class="preview-content">
            <div class="preview-label">您選擇的項目</div>
            <div class="preview-title">${safeName}</div>
            <button class="change-selection-btn">重新選擇</button>
        </div>
    `;
    
    // Show selected card
    elSelectedCard.classList.add('show-selected');

    // Update selected card styling in the menu
    updateMenuStates();
    
    // Check if we can enable submit button
    checkCanSubmit();
}

// Clear Selection
function clearSelection() {
    selectedDrink = null;
    const brandNames = {
        'starbucks': { categoryLabel: '選擇飲品' },
        'burgerking': { categoryLabel: '選擇餐點' }
    };
    const brand = brandNames[storeId] || { categoryLabel: '選擇商品' };
    elSelectedDrinkPreview.innerHTML = `<span class="preview-empty-text">請在下方選單點選您想點的${brand.categoryLabel.slice(2)}</span>`;
    
    // Hide selected card
    elSelectedCard.classList.remove('show-selected');
    
    updateMenuStates();
    checkCanSubmit();
}

// Form verification
function checkCanSubmit() {
    const name = elPersonName.value.trim();
    if (name && selectedDrink && getOrderWindowState() === 'open') {
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
        allOrders = snapshot.docs.map(d => {
            const data = d.data();
            return {
                name: data.name || '',
                drink: data.drink || '',
                img: data.img || '',
                createdAt: data.createdAt || null
            };
        });
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
            allOrders = data.orders;
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
        } else {
            showWindowSetupCard();
        }
    } catch (err) {
        console.warn('Failed to load group ordering window', err);
    }
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
    elWindowSetupCard.style.display = '';
    elWindowSetupBtn.addEventListener('click', submitWindowSetup);
}

async function submitWindowSetup() {
    const openAt = elWindowOpenInput.value ? new Date(elWindowOpenInput.value) : null;
    const closeAt = elWindowCloseInput.value ? new Date(elWindowCloseInput.value) : null;

    if (!openAt || !closeAt || isNaN(openAt) || isNaN(closeAt)) {
        alert('請填寫完整的開團與截止時間。');
        return;
    }
    if (closeAt <= openAt) {
        alert('截止時間必須晚於開團時間。');
        return;
    }
    if (!confirm(`確定要設定本團期限嗎？\n開團：${formatWindowTime(openAt)}\n截止：${formatWindowTime(closeAt)}\n\n設定後不可修改。`)) {
        return;
    }

    elWindowSetupBtn.setAttribute('disabled', 'true');
    elWindowSetupBtn.querySelector('span').textContent = '正在建立...';

    try {
        await setDoc(doc(firestoreDb, 'groups', groupId), {
            openAt: Timestamp.fromDate(openAt),
            closeAt: Timestamp.fromDate(closeAt),
            createdAt: serverTimestamp()
        });
        groupWindow = { openAt, closeAt };
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
    elOrderWindowBanner.textContent = `${stateText}　${range}`;
    elOrderWindowBanner.dataset.state = state;
    elOrderWindowBanner.style.display = '';
    checkCanSubmit();
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
    
    allOrders = readOrdersFromLocalStorage(localKey);
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

// Submit Order API call
async function submitOrder() {
    const name = elPersonName.value.trim();
    if (!name || !selectedDrink) return;

    const windowState = getOrderWindowState();
    if (windowState !== 'open') {
        alert(windowState === 'before' ? '尚未到開團時間，請稍後再點餐。' : '已超過收單期限，本團已截止點餐。');
        renderOrderWindowBanner();
        return;
    }

    elSubmitBtn.setAttribute('disabled', 'true');
    elSubmitBtn.querySelector('span').textContent = '正在送出點餐...';

    const orderPayload = {
        groupId: groupId,
        name: name,
        drink: selectedDrink.name,
        img: selectedDrink.img
    };

    if (isMockMode) {
        await new Promise(resolve => setTimeout(resolve, 800));

        const localKey = getLocalStorageKey();
        const currentMock = readOrdersFromLocalStorage(localKey);
        currentMock.push(orderPayload);
        localStorage.setItem(localKey, JSON.stringify(currentMock));

        showSuccessScreen(name, selectedDrink.name);
        return;
    }

    if (shouldUseFirebase()) {
        try {
            await addDoc(getFirebaseOrdersCollection(), {
                name: name,
                drink: selectedDrink.name,
                img: selectedDrink.img,
                createdAt: serverTimestamp()
            });

            showSuccessScreen(name, selectedDrink.name);
        } catch (err) {
            console.error('Firebase submit failed', err);
            alert('雲端送出失敗，請確認網路連線後再重試。');
            elSubmitBtn.removeAttribute('disabled');
            elSubmitBtn.querySelector('span').textContent = '確認送出點餐';
        }
        return;
    }

    try {
        const res = await fetch(`${API_BASE}order.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderPayload)
        });
        const data = await res.json();

        if (data.success) {
            showSuccessScreen(name, selectedDrink.name);
        } else {
            alert(data.error || '點餐送出失敗，請重試！');
            elSubmitBtn.removeAttribute('disabled');
            elSubmitBtn.querySelector('span').textContent = '確認送出點餐';
        }
    } catch (err) {
        console.error('Submit failed', err);
        alert('雲端送出失敗，請確認網路連線後再重試。');
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
