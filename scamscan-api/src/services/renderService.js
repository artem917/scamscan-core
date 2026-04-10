const puppeteer = require('puppeteer');

// Глобальная очередь (простейшая реализация через промис-цепочку)
// Мы используем переменную lock, чтобы не пускать параллельные запуски.
let isRendering = false;
const QUEUE_TIMEOUT = 10000; // 10 сек ждем очереди, потом отказ

// Функция ожидания (sleep)
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getPageContent(url) {
    // 1. Механизм очереди (Spin lock light)
    const startTime = Date.now();
    while (isRendering) {
        if (Date.now() - startTime > QUEUE_TIMEOUT) {
            throw new Error("Server busy (render queue full). Try again later.");
        }
        await wait(500); // Ждем 0.5 сек и проверяем снова
    }

    isRendering = true;
    let browser = null;

    try {
        // 2. Запуск браузера с минимальными настройками
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Используем /tmp вместо /dev/shm (экономит RAM)
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process' // Важно для слабых серверов!
            ]
        });

        const page = await browser.newPage();

        // 3. Агрессивная экономия ресурсов (Блокируем лишнее)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                req.abort(); // Не грузим картинки и стили
            } else {
                req.continue();
            }
        });

        // 4. Переходим и ждем (Таймаут 15 сек)
        await page.goto(url, { 
            waitUntil: 'domcontentloaded', // Ждем только HTML, не ждем полную загрузку сети
            timeout: 15000 
        });

        // Ждем еще 1 сек, чтобы JS успел отрендерить базовый React/Vue
        await wait(1000);

        // 5. Забираем текст
        const content = await page.content(); // Весь HTML
        const text = await page.evaluate(() => document.body.innerText); // Чистый текст

        return { html: content, text: text };

    } catch (e) {
        console.error("Puppeteer Render Error:", e.message);
        throw e; // Пробрасываем ошибку наверх
    } finally {
        // 6. Гарантированно убиваем процесс
        if (browser) {
            await browser.close();
        }
        isRendering = false; // Освобождаем очередь
    }
}

module.exports = { getPageContent };
