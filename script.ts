import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { once } from "node:events";

import { load } from "cheerio";
import { Command, InvalidArgumentError } from "commander";
import { stringify } from "csv-stringify";
import pRetry from "p-retry";

const PAGE_SIZE = 60;
const DETAIL_CONCURRENCY = 5;
const HEADERS = {
  "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
};

type Cache = Record<string, any>;
type SearchResult = {
  count: number;
  products: Array<{ id: string }>;
};
type ProductDetail = {
  discountPercentage: number | "";
  originalPrice: string;
  rating: number | "";
  reviewCount: string | number;
  soldText: string;
};

function parsePositiveInt(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive integer.");
  }

  return parsed;
}

function defaultOutputPath(categoryUrl: string) {
  const url = new URL(categoryUrl);
  const slug = url.pathname.split("/").filter(Boolean).pop() || "tokopedia-category";
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return join(process.cwd(), "output", `${slug}-${timestamp}.csv`);
}

async function fetchCache(pageUrl: string, label: string) {
  return pRetry(
    async () => {
      const response = await fetch(pageUrl, {
        headers: HEADERS,
        redirect: "follow",
      });

      if (!response.ok) {
        throw new Error(`Tokopedia responded with HTTP ${response.status}`);
      }

      const html = await response.text();
      const $ = load(html);
      const script = $("script")
        .toArray()
        .map((element) => $(element).html() || "")
        .find((content) => content.includes("window.__cache="));

      if (!script) {
        throw new Error("Could not find Tokopedia cache data in the page.");
      }

      const rawJson = script
        .slice(script.indexOf("window.__cache=") + "window.__cache=".length)
        .trim()
        .replace(/;$/, "");

      return JSON.parse(rawJson) as Cache;
    },
    {
      retries: 3,
      minTimeout: 1_000,
      onFailedAttempt(error) {
        const message = error.error instanceof Error ? error.error.message : String(error.error);
        console.warn(`Retry ${error.attemptNumber} (${label}): ${message}`);
      },
    },
  );
}

async function fetchCategoryPage(pageUrl: string) {
  const cache = await fetchCache(pageUrl, `category page ${pageUrl}`);
  const searchKey = Object.keys(cache).find((key) => key.startsWith("$ROOT_QUERY.searchProduct("));
  if (!searchKey) {
    throw new Error("Could not find product search data in the page.");
  }

  return {
    cache,
    search: cache[searchKey] as SearchResult,
  };
}

async function fetchProductDetail(productUrl: string) {
  const cache = await fetchCache(productUrl, `product detail ${productUrl}`);
  const basicKey = Object.keys(cache).find((key) => /^pdpBasicInfo\d+$/.test(key));
  if (!basicKey) {
    throw new Error("Could not find PDP detail data in the page.");
  }

  const stats = cache[`$${basicKey}.stats`];
  const txStats = cache[`$${basicKey}.txStats`];
  const price = Object.values(cache).find(
    (entry) => entry && typeof entry === "object" && entry.__typename === "pdpContentSnapshotPrice",
  ) as
    | {
        priceFmt?: string;
        slashPriceFmt?: string;
        discPercentage?: string | number;
      }
    | undefined;
  let discountPercentage: number | "" = "";

  if (typeof price?.discPercentage === "number") {
    discountPercentage = price.discPercentage;
  } else if (typeof price?.discPercentage === "string") {
    const parsed = Number.parseFloat(price.discPercentage.replace(/[^\d.-]/g, ""));
    if (Number.isFinite(parsed)) {
      discountPercentage = parsed;
    }
  }

  let soldText = "";
  if (typeof txStats?.itemSoldFmt === "string" && txStats.itemSoldFmt.trim()) {
    soldText = `${txStats.itemSoldFmt.trim()} terjual`;
  } else if (typeof txStats?.countSold === "string" && txStats.countSold.trim()) {
    soldText = `${txStats.countSold.trim()} terjual`;
  }

  return {
    discountPercentage,
    originalPrice: price?.slashPriceFmt || "",
    rating: typeof stats?.rating === "number" ? stats.rating : "",
    reviewCount:
      typeof stats?.countReview === "string" || typeof stats?.countReview === "number" ? stats.countReview : "",
    soldText,
  };
}

const program = new Command()
  .name("script.ts")
  .description("Scrape Tokopedia category pages into CSV.")
  .argument("<url>", "Tokopedia category URL")
  .option("-l, --limit <number>", "Maximum number of products to scrape", parsePositiveInt)
  .showHelpAfterError();

program.parse();

const categoryUrl = program.args[0];
if (!categoryUrl) {
  throw new Error("Category URL is required.");
}

const parsedUrl = new URL(categoryUrl);
if (!parsedUrl.hostname.endsWith("tokopedia.com") || !parsedUrl.pathname.startsWith("/p/")) {
  throw new Error("URL must be a Tokopedia category URL under /p/.");
}

const options = program.opts<{ limit?: number }>();
const limit = options.limit ?? Number.POSITIVE_INFINITY;
const outputPath = defaultOutputPath(categoryUrl);

await mkdir(dirname(outputPath), { recursive: true });

const csv = stringify({
  header: true,
  columns: [
    "product_id",
    "product_name",
    "price",
    "price_int",
    "original_price",
    "discount_percentage",
    "rating",
    "review_count",
    "sold_text",
    "shop_id",
    "shop_name",
    "shop_city",
    "product_url",
    "image_url",
  ],
});

const fileStream = createWriteStream(outputPath, { encoding: "utf8" });
csv.pipe(fileStream);

let page = 1;
let written = 0;
let totalAvailable = 0;

console.log(`Scraping category: ${categoryUrl}`);
console.log(`CSV output: ${outputPath}`);
console.log(`Row limit: ${Number.isFinite(limit) ? limit : "all available products"}`);

while (written < limit) {
  const pageUrl = new URL(categoryUrl);
  if (page > 1) {
    pageUrl.searchParams.set("page", String(page));
  } else {
    pageUrl.searchParams.delete("page");
  }

  const { cache, search } = await fetchCategoryPage(pageUrl.toString());
  totalAvailable = search.count;

  if (search.products.length === 0) {
    break;
  }

  const pageProducts = search.products
    .map((reference) => cache[reference.id])
    .filter((product): product is any => Boolean(product));
  const pageLimit = Number.isFinite(limit) ? Math.max(limit - written, 0) : pageProducts.length;
  const productsToProcess = pageProducts.slice(0, pageLimit);

  for (let batchStart = 0; batchStart < productsToProcess.length; batchStart += DETAIL_CONCURRENCY) {
    const batchProducts = productsToProcess.slice(batchStart, batchStart + DETAIL_CONCURRENCY);
    const batchDetails = await Promise.all(
      batchProducts.map(async (product) => {
        try {
          return await fetchProductDetail(product.url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`Falling back to listing data for ${product.url}: ${message}`);
          return null;
        }
      }),
    );

    for (const [index, product] of batchProducts.entries()) {
      const detail = batchDetails[index];
      const shop = product.shop ? cache[product.shop.id] : null;
      const soldText =
        detail?.soldText ||
        (product.label_groups || [])
          .map((label: { id: string }) => cache[label.id]?.title)
          .find((title: unknown) => typeof title === "string" && /terjual|sold/i.test(title)) ||
        "";

      written += 1;

      if (!csv.write({
        product_id: String(product.id),
        product_name: product.name || "",
        price: product.price || "",
        price_int: product.price_int ?? "",
        original_price: detail?.originalPrice || product.original_price || "",
        discount_percentage: detail?.discountPercentage ?? product.discount_percentage ?? "",
        rating: detail?.rating ?? product.rating ?? "",
        review_count: detail?.reviewCount ?? product.count_review ?? "",
        sold_text: soldText,
        shop_id: shop ? String(shop.id) : "",
        shop_name: shop?.name || "",
        shop_city: shop?.city || shop?.location || "",
        product_url: product.url || "",
        image_url: product.image_url || "",
      })) {
        await once(csv, "drain");
      }
    }
  }

  console.log(`Page ${page}: wrote ${written} row(s) so far.`);

  if (written >= limit || page * PAGE_SIZE >= totalAvailable) {
    break;
  }

  page += 1;
}

csv.end();
await once(fileStream, "finish");

console.log("");
console.log("Scrape complete.");
console.log(`Rows written: ${written}`);
console.log(`Tokopedia reported total available results: ${totalAvailable}`);
console.log(`Pages fetched: ${page}`);
console.log(`CSV saved to: ${outputPath}`);
