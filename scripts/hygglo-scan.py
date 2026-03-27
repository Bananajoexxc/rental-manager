#!/usr/bin/env python3
"""
Weekly Hygglo listing scanner.
Fetches all active listings from Hygglo public API for both accounts,
compares against pricing-catalog.ts, and flags new/changed listings.
New listings are added as marketing-only until manually confirmed.
"""
import requests
import json
import time
import os
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
log = logging.getLogger(__name__)

ACCOUNTS = {
    'dbcinema': {'slug_prefix': 'db-cinema', 'search': 'db cinema'},
    'leo': {'slug_prefix': 'leo-adams', 'search': 'leo adams'},
}

CATALOG_PATH = '/home/ubuntu/rental-manager/src/data/pricing-catalog.ts'
SCAN_RESULTS_PATH = '/home/ubuntu/rental-manager/src/data/hygglo-scan-results.json'

def fetch_listings(account_name):
    """Fetch listings from Hygglo public API."""
    listings = []
    page = 1
    while page <= 10:
        try:
            r = requests.get(
                f'https://api.hygglo.com/api/v2/search',
                params={'q': ACCOUNTS[account_name]['search'], 'page': page, 'per_page': 50},
                headers={'Country': 'GB', 'Accept': 'application/json', 'User-Client': 'Hygglo-web'},
                timeout=15,
            )
            if r.status_code != 200:
                break
            data = r.json()
            results = data.get('results', data.get('data', []))
            if not results:
                break
            listings.extend(results)
            page += 1
            time.sleep(0.5)
        except Exception as e:
            log.warning(f'Fetch error page {page}: {e}')
            break
    return listings

def read_current_catalog():
    """Read item names from pricing-catalog.ts."""
    with open(CATALOG_PATH) as f:
        content = f.read()
    import re
    items = re.findall(r"item_name:\s*'([^']+)'", content)
    return set(items)

def scan():
    """Run the weekly scan."""
    log.info('Starting weekly Hygglo listing scan...')

    current_catalog = read_current_catalog()
    log.info(f'Current catalog: {len(current_catalog)} items')

    all_listings = []
    for account in ACCOUNTS:
        listings = fetch_listings(account)
        log.info(f'{account}: {len(listings)} listings found')
        for l in listings:
            all_listings.append({
                'account': account,
                'title': l.get('title', ''),
                'slug': l.get('slug', ''),
                'price': l.get('price', 0),
                'currency': l.get('currency', 'GBP'),
            })

    # Find new listings not in catalog
    new_listings = []
    for l in all_listings:
        title = l['title']
        # Check if any catalog item name is a substring of the listing title
        found = False
        for cat_item in current_catalog:
            if cat_item.lower() in title.lower() or title.lower() in cat_item.lower():
                found = True
                break
        if not found:
            new_listings.append(l)

    # Save results
    results = {
        'scan_date': time.strftime('%Y-%m-%d %H:%M:%S'),
        'total_listings': len(all_listings),
        'catalog_items': len(current_catalog),
        'new_listings': new_listings,
        'all_listings': all_listings,
    }

    with open(SCAN_RESULTS_PATH, 'w') as f:
        json.dump(results, f, indent=2)

    if new_listings:
        log.info(f'Found {len(new_listings)} NEW listings not in catalog:')
        for l in new_listings:
            log.info(f'  [{l["account"]}] {l["title"]} - £{l["price"]}')

        # Send Telegram notification
        try:
            msg = f'🔍 Hygglo Weekly Scan\n\n{len(new_listings)} new listings found:\n'
            for l in new_listings[:10]:
                msg += f'\n• [{l["account"]}] {l["title"]} (£{l["price"]})'
            msg += f'\n\nTotal active listings: {len(all_listings)}'
            msg += f'\nCatalog items: {len(current_catalog)}'
            msg += '\n\nNew listings are treated as marketing-only until confirmed.'

            requests.post(
                'https://api.telegram.org/bot8153306931:AAHt88wJ4GMlC4HhDudc6TT_E_vml60soew/sendMessage',
                json={'chat_id': '6634478551', 'text': msg},
                timeout=10,
            )
        except:
            pass
    else:
        log.info('No new listings found — catalog is up to date')

    log.info('Scan complete')

if __name__ == '__main__':
    scan()
