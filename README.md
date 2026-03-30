# Tokopedia Category Scraper

## Install

```bash
bun install
```

## Run

Scrape every available result from a Tokopedia category:

```bash
bun script.ts https://www.tokopedia.com/p/elektronik/elektronik-rumah-tangga/mesin-cuci
```

Scrape with a limit:

```bash
bun script.ts https://www.tokopedia.com/p/elektronik/elektronik-rumah-tangga/mesin-cuci --limit 100
```

The script automatically creates a timestamped CSV inside `./output/`, using the category page name in the filename.

## Output columns

The CSV includes the required fields plus useful extras:

- `product_id`
- `product_name`
- `price`
- `rating`
- `review_count`
- `sold_text`
- `shop_id`
- `shop_name`
- `shop_city`
- `product_url`
- `image_url`
