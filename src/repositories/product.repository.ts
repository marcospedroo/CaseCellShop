import type { Product } from '../types';

const products: Product[] = [
  {
    id: 'prod-001',
    name: 'iPhone 15 Case - Clear',
    price: 29.99,
    stock: 50,
    category: 'cases',
    description: 'Transparent protective case for iPhone 15',
  },
  {
    id: 'prod-002',
    name: 'Samsung Galaxy S24 Case - Black',
    price: 24.99,
    stock: 30,
    category: 'cases',
    description: 'Premium matte black case for Samsung Galaxy S24',
  },
  {
    id: 'prod-003',
    name: 'Screen Protector - Universal 6.5"',
    price: 12.99,
    stock: 100,
    category: 'screen-protectors',
    description: 'Tempered glass screen protector 6.5 inch',
  },
  {
    id: 'prod-004',
    name: 'Wireless Charger 15W',
    price: 39.99,
    stock: 20,
    category: 'chargers',
    description: 'Fast wireless charger compatible with all Qi devices',
  },
  {
    id: 'prod-005',
    name: 'USB-C Cable 2m',
    price: 14.99,
    stock: 1,
    category: 'cables',
    description: 'Braided USB-C to USB-C cable 2 meters',
  },
];

export interface IProductRepository {
  findAll(): Promise<Product[]>;
  findById(id: string): Promise<Product | undefined>;
  decrementStock(productId: string, quantity: number): Promise<boolean>;
  incrementStock(productId: string, quantity: number): Promise<void>;
}

export class InMemoryProductRepository implements IProductRepository {
  private readonly items: Product[];

  constructor(initialProducts?: Product[]) {
    this.items = initialProducts ?? products;
  }

  findAll(): Promise<Product[]> {
    return Promise.resolve(this.items.map((p) => ({ ...p })));
  }

  findById(id: string): Promise<Product | undefined> {
    const product = this.items.find((p) => p.id === id);
    return Promise.resolve(product ? { ...product } : undefined);
  }

  decrementStock(productId: string, quantity: number): Promise<boolean> {
    const product = this.items.find((p) => p.id === productId);
    if (!product || product.stock < quantity) {
      return Promise.resolve(false);
    }
    product.stock -= quantity;
    return Promise.resolve(true);
  }

  incrementStock(productId: string, quantity: number): Promise<void> {
    const product = this.items.find((p) => p.id === productId);
    if (product) {
      product.stock += quantity;
    }
    return Promise.resolve();
  }

  getItems(): Product[] {
    return this.items;
  }
}

export const productRepository = new InMemoryProductRepository();
