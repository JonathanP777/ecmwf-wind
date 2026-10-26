"""Headless check: render the site and save screenshots."""
import asyncio, sys
from playwright.async_api import async_playwright
URL = "http://localhost:8765/"
VIEWS = [("global", 20, 0, 2), ("europe", 50, 10, 5), ("us", 39, -96, 4), ("uk_zoom", 54, -3, 7)]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1400, "height": 850})
        pg.on("console", lambda m: print("console:", m.text))
        pg.on("pageerror", lambda e: print("PAGEERROR:", e))
        await pg.goto(URL); await pg.wait_for_timeout(4000)
        for name, lat, lon, z in VIEWS:
            await pg.evaluate(f"_windDebug.map.setView([{lat},{lon}],{z},{{animate:false}})")
            await pg.wait_for_timeout(4000)
            if name == "us":
                await pg.evaluate("document.getElementById('slider').value=16; document.getElementById('slider').dispatchEvent(new Event('input'))")
                await pg.wait_for_timeout(3000)
            await pg.mouse.move(700, 425)
            await pg.wait_for_timeout(300)
            await pg.screenshot(path=f"screenshots/{name}.png"); print("saved", name)
        await b.close()
asyncio.run(main())
