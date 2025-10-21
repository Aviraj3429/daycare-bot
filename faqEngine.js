export function detectIntent(message) {
  message = message.toLowerCase();

  if (message.includes('fee') || message.includes('price') || message.includes('cost')) return 'fees';
  if (message.includes('hour') || message.includes('time') || message.includes('open') || message.includes('close')) return 'hours';
  if (message.includes('meal') || message.includes('food') || message.includes('lunch') || message.includes('snack')) return 'meals';
  if (message.includes('program') || message.includes('curriculum') || message.includes('age group')) return 'programs';
  if (message.includes('tour') || message.includes('visit') || message.includes('see')) return 'tour';
  if (message.includes('emergency') || message.includes('urgent') || message.includes('now')) return 'urgent';
  if (message.includes('enroll') || message.includes('admission') || message.includes('seat')) return 'openings';
  
  return 'general';
}

export function answerForIntent(intent, daycare) {
  const name = daycare.name || 'our daycare';

  const answers = {
    fees: `At ${name}, our fees depend on your child’s age and program. Would you like me to send you a fee sheet or connect you with the director?`,
    hours: `${name} is usually open during the hours mentioned on our website or daycare details — typically around ${daycare.hours || '7 AM to 6 PM'}.`,
    meals: `${name} provides healthy meals and snacks throughout the day. ${daycare.meals || 'All meals are prepared fresh daily.'}`,
    programs: `${name} offers several programs for different age groups. ${daycare.programs || 'We focus on play-based learning and early literacy.'}`,
    tour: `You can book a tour at ${daycare.tour_link || 'our tour page online.'}`,
    urgent: `Okay, this seems urgent. Please hold while I connect you to the daycare owner.`,
    openings: `We currently have limited openings. May I know your child’s age so I can check availability?`,
    general: `Thanks for your question! I can answer about fees, hours, meals, programs, or help you book a tour of ${name}.`
  };

  return answers[intent] || answers.general;
}
