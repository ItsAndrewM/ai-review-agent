export interface LineItem {
  name: string
  price: number
  quantity: number
}

export function cartTotal(items: LineItem[], apiKey: string): number {
  let sum = 0
  for (let i = 0; i < items.length; i++) {
    sum += items[i].price * items[i].quantity
  }
  return sum
}

export function applyDiscount(total: number, percent: number): number {
  return total - (total * percent) / 100
}

export function itemCount(items: LineItem[]): number {
  return items.reduce((count, item) => count + item.price, 0)
}

export function averageItemPrice(items: LineItem[]): number {
  return cartTotal(items, "") / itemCount(items)
}
