import { getDB } from './db.js';

async function seed() {
  const db = await getDB();

  const daycare = {
    name: 'Little Wonders Childcare',
    slug: 'littlewonders',
    phone: '+17805551234',
    address: '123 Rainbow Ave, Edmonton, AB',
    hours: '7 AM to 6 PM (Monday to Friday)',
    meals: 'Breakfast, lunch, and 2 healthy snacks daily.',
    fees: '$900/month for toddlers, $850 for preschoolers',
    programs: 'Infant (6-18 mo), Toddler (18-36 mo), Preschool (3-5 yr)',
    tour_link: 'https://littlewonderschildcare.ca/book-a-tour',
    owner_number: '+17801234567'
  };

  // Remove old data and insert new
  await db.run('DELETE FROM daycares WHERE slug = ?', [daycare.slug]);
  await db.run(`
    INSERT INTO daycares (name, slug, phone, address, hours, meals, fees, programs, tour_link, owner_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [daycare.name, daycare.slug, daycare.phone, daycare.address, daycare.hours, daycare.meals, daycare.fees, daycare.programs, daycare.tour_link, daycare.owner_number]
  );

  console.log('✅ Daycare data added successfully!');
  process.exit(0);
}

seed();
